/**
 * 中文固定监听器测试：验证公开端口不变、旧 SSE 排空、新请求排队和状态端口修正。
 * 工作进程是本机假的 HTTP 服务，不访问真实供应商。
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createHandoffListener } from "../../lib/handoff-listener.js";

const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; assert.ok(port >= 15725); return port;
}
async function worker(id, groupId = "quality") {
  const streams = new Set();
  const payload = () => ({ running: true, processId: process.pid, port: server.address().port,
    build: { version: "test", releaseId: id, codeHash: id }, persistence: { configPath: "/data/config", usagePath: "/data/usage" },
    handoff: { worker: true }, security: { loopbackOnly: true }, groups: ["default", groupId].map((key) => ({ id: key,
      listener: { enabled: true, host: "127.0.0.1", port: server.address().port }, listenerStatus: "listening", actualListener: { host: "127.0.0.1", port: server.address().port } })) });
  let finishCurrent = () => {}; const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/api/status/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      streams.add(res); res.once("close", () => streams.delete(res));
      const bytes = Buffer.from(event("status", payload()));
      res.write(bytes.subarray(0, 23)); res.write(bytes.subarray(23)); return;
    }
    if (["/api/status", "/api/groups", "/api/config"].includes(pathname)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pathname === "/api/groups" ? payload().groups : payload())); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (body.input === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write(event("response.created", { worker: id }));
      finishCurrent = () => res.end(event("response.completed", { worker: id })); return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ worker: id, group: req.headers["x-lite-ccswitch-group-id"] || "default" }));
  });
  const port = await listen(server); return { id, mainPort: port, groups: { [groupId]: port }, server, streams, finish: () => finishCurrent() };
}
async function reserve() { const server = http.createServer(); const port = await listen(server); await close(server); return port; }
async function request(port, body) {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

test("固定监听器在旧 SSE 排空时排队新请求，激活新版本后不返回 503", async (t) => {
  const old = await worker("old"); const next = await worker("next"); const publicPort = await reserve(); const groupPort = await reserve();
  const listener = createHandoffListener({ mainPort: publicPort, groups: [{ id: "quality", port: groupPort }], queueOptions: { maxWaitMs: 2000 } });
  t.after(async () => { await listener.close(); await close(old.server); await close(next.server); });
  await listener.listen(); listener.setTarget(old);
  const streaming = await request(publicPort, { stream: true, input: "hold" }); const text = streaming.text();
  listener.beginDrain(); const queued = request(publicPort, { stream: false, input: "new" });
  await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(listener.queue.stats().queuedRequests, 1);
  old.finish(); assert.match(await text, /response.completed/); listener.activate(next);
  const response = await queued; assert.equal(response.status, 200); assert.deepEqual(await response.json(), { worker: "next", group: "default" });
});

test("状态接口通过固定监听器公开主端口和分组端口", async (t) => {
  const old = await worker("status"); const guard = http.createServer(); const publicPort = await listen(guard); await close(guard);
  const listener = createHandoffListener({ mainPort: publicPort, groups: [] }); t.after(async () => { await listener.close(); await close(old.server); });
  await listener.listen(); listener.setTarget(old);
  const status = await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json());
  assert.equal(status.port, publicPort); assert.equal(status.publicPort, publicPort); assert.equal(status.handoff.listener, "fixed");
});

test("带参数状态、分组和配置接口均返回公开端口", async (t) => {
  const old = await worker("public-info"); const publicPort = await reserve(); const qualityPort = await reserve();
  const listener = createHandoffListener({ mainPort: publicPort, groups: [{ id: "quality", port: qualityPort }] });
  t.after(async () => { await listener.close(); await close(old.server); });
  await listener.listen(); listener.setTarget(old);
  for (const endpoint of ["/api/status?groupId=quality", "/api/groups", "/api/config"]) {
    const response = await fetch(`http://127.0.0.1:${publicPort}${endpoint}`).then((r) => r.json());
    const groups = Array.isArray(response) ? response : response.groups;
    assert.equal(groups.find((group) => group.id === "default").listener.port, publicPort, endpoint);
    assert.equal(groups.find((group) => group.id === "quality").listener.port, qualityPort, endpoint);
    assert.equal(groups.find((group) => group.id === "quality").actualListener.port, qualityPort, endpoint);
  }
});

test("公网固定监听不能因工作进程使用本机地址而跳过认证", async (t) => {
  const old = await worker("public-auth"); const publicPort = await reserve(); const qualityPort = await reserve();
  const listener = createHandoffListener({ host: "0.0.0.0", mainPort: publicPort, groups: [{ id: "quality", host: "0.0.0.0", port: qualityPort }] });
  t.after(async () => { await listener.close(); await close(old.server); });
  await listener.listen(); listener.setTarget(old);
  const admin = await fetch(`http://127.0.0.1:${publicPort}/api/status`); assert.equal(admin.status, 503);
  assert.equal((await admin.json()).error.type, "admin_auth_not_configured");
  for (const port of [publicPort, qualityPort]) {
    const proxy = await request(port, { input: "denied" }); assert.equal(proxy.status, 503);
    assert.equal((await proxy.json()).error.type, "proxy_auth_not_configured");
  }
});

test("状态 SSE 显示公开端口，版本切换保留同一客户端连接并释放旧订阅", async (t) => {
  const old = await worker("旧版本-中文"); const next = await worker("新版本-中文");
  const publicPort = await reserve(); const qualityPort = await reserve();
  const listener = createHandoffListener({ mainPort: publicPort, groups: [{ id: "quality", port: qualityPort }] });
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await listener.close(); await close(old.server); await close(next.server); });
  await listener.listen(); listener.setTarget(old);
  const response = await fetch(`http://127.0.0.1:${publicPort}/api/status/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const decoder = new TextDecoder(); const values = []; let pending = "";
  const reading = (async () => {
    try {
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true }); let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) values.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  const until = async (check) => { for (let i = 0; i < 100; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("等待状态流超时"); };
  await until(() => old.streams.size === 1 && values.length > 0);
  listener.activate(next);
  await until(() => values.some((value) => value.build.releaseId === next.id));
  await until(() => old.streams.size === 0);
  assert.ok(values.every((value) => value.port === publicPort && value.groups[1].listener.port === qualityPort && value.groups[1].actualListener.port === qualityPort));
  assert.ok(values.every((value) => value.handoff.listener === "fixed"));
  controller.abort(); await reading;
  await until(() => next.streams.size === 0);
});

test("固定监听复用管理 Cookie，令牌与管理会话按原规则区分", async (t) => {
  const old = await worker("tokens"); const publicPort = await reserve();
  const listener = createHandoffListener({ host: "0.0.0.0", mainPort: publicPort, proxyToken: "proxy-only", adminToken: "admin-only" });
  t.after(async () => { await listener.close(); await close(old.server); });
  await listener.listen(); listener.setTarget(old);
  const base = `http://127.0.0.1:${publicPort}`;
  assert.equal((await fetch(`${base}/api/status`, { headers: { "x-lite-ccswitch-token": "proxy-only" } })).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "admin-only" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const response = await fetch(`${base}/api/status`, { headers: { cookie } });
  assert.equal(response.status, 200); assert.equal((await response.json()).security.loopbackOnly, false);
  const denied = await request(publicPort, { input: "no-proxy-token" }); assert.equal(denied.status, 401);
  const proxy = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-lite-ccswitch-token": "proxy-only" }, body: "{}" });
  assert.equal(proxy.status, 200); await proxy.text();
});

test("正常请求体上限与交接排队上限分开，排队超限不会发送上游", async (t) => {
  const old = await worker("body-limits"); const publicPort = await reserve();
  const listener = createHandoffListener({ mainPort: publicPort, maxBodyBytes: 2048, queueOptions: { maxBytes: 1024 } });
  t.after(async () => { await listener.close(); await close(old.server); });
  await listener.listen(); listener.setTarget(old);
  const body = { input: "x".repeat(1500) };
  const direct = await request(publicPort, body); assert.equal(direct.status, 200); await direct.text();
  listener.beginDrain();
  const waiting = await request(publicPort, body); assert.equal(waiting.status, 413); await waiting.text();
  assert.equal(listener.queue.stats().queuedBytes, 0);
  listener.activate(old);
});
