/**
 * 中文固定监听管理兼容演练：真实 Lite 的公网认证、环境文件、公开端口与跨版本状态流。
 * 所有版本、数据及端口独立；假上游记录认证头，用于确认管理令牌不会流出本机代理。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error("等待管理兼容验收状态超时");
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; assert.ok(port >= 15725); return port;
}
async function reserve() { const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }

test("真实 Lite 的认证、公开端口与跨版本状态 SSE 保持一致", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-management-"));
  const data = path.join(root, "data"); await mkdir(data);
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "management-candidate"); await createReleaseSnapshot(ROOT, fallback, "management-fallback");
  const upstreamHeaders = []; let supervisor;
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { /* 消费本机测试请求。 */ }
    upstreamHeaders.push(req.headers); res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const controller = new AbortController(); let reading = null;
  t.after(async () => {
    controller.abort(); await reading;
    await supervisor?.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const upstreamPort = await listen(upstream); const publicPort = await reserve(); const qualityPort = await reserve();
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake-upstream-key" }],
    groups: [ { id: "default", name: "默认", listener: { host: "0.0.0.0", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] },
      { id: "quality", name: "高质量", listener: { host: "0.0.0.0", port: qualityPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] } ], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  await writeFile(path.join(data, "runtime.env"), `LITE_CCSWITCH_PROXY_TOKEN=test-proxy\nLITE_CCSWITCH_ADMIN_TOKEN=test-admin\nLITE_CCSWITCH_CONFIG=${path.join(root, "wrong-config.json")}\nLITE_CCSWITCH_PRICE_LAB=${path.join(root, "wrong-price-lab.json")}\n`);
  const events = [];
  supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, host: "0.0.0.0", observeMs: 10000,
    healthPolicy: { intervalMs: 100 }, log: (line) => events.push(line) });
  await supervisor.start();
  const base = `http://127.0.0.1:${publicPort}`;
  const headers = { "x-lite-ccswitch-token": "test-admin" };
  const saveExchangeRate = await fetch(`${base}/api/price-lab/exchange-rate`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ mode: "manual", rate: 7.1234 }),
  });
  assert.equal(saveExchangeRate.status, 200);
  const sharedRate = await fetch(`${base}/api/price-lab/exchange-rate?groupId=quality`, { headers }).then((r) => r.json());
  assert.equal(sharedRate.rate.rate, 7.1234, "不同分组使用同一份汇率缓存");
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: { "x-lite-ccswitch-token": "test-proxy" } })).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"token":"test-admin"}' });
  assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie").split(";")[0];
  const assertPublic = (status) => {
    if (!Array.isArray(status)) { assert.equal(status.port, publicPort); assert.equal(status.handoff.listener, "fixed"); assert.equal(status.security.loopbackOnly, false); }
    for (const group of Array.isArray(status) ? status : status.groups) {
      const port = group.id === "default" ? publicPort : qualityPort;
      assert.equal(group.listener.port, port); assert.equal(group.actualListener.port, port); assert.equal(group.actualListener.host, "0.0.0.0");
    }
  };
  for (const endpoint of ["/api/status", "/api/status?groupId=quality", "/api/groups"]) assertPublic(await fetch(`${base}${endpoint}`, { headers: { cookie } }).then((r) => r.json()));
  const config = await fetch(`${base}/api/config`, { headers }).then((r) => r.json());
  assert.equal(config.groups.find((group) => group.id === "quality").listener.port, qualityPort);
  const privateStatus = await fetch(`http://127.0.0.1:${supervisor.current().mainPort}/api/status`, { headers }).then((r) => r.json());
  assert.ok(privateStatus.groups.every((group) => group.actualListener.host === "127.0.0.1"));
  assert.equal(privateStatus.persistence.configPath, path.join(await realpath(data), "config.json"));
  assert.equal(privateStatus.persistence.priceLabPath, path.join(await realpath(data), "price-lab.json"));
  const response = await fetch(`${base}/api/status/events?groupId=quality`, { headers: { cookie }, signal: controller.signal });
  assert.equal(response.status, 200); const states = []; const decoder = new TextDecoder(); let pending = "";
  reading = (async () => {
    try {
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true }); let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const line = frame.split("\n").find((item) => item.startsWith("data: ")); if (line) states.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  await until(() => states.some((status) => status.build.releaseId === "management-candidate"));
  await supervisor.upgrade(fallback);
  await until(() => states.some((status) => status.build.releaseId === "management-fallback"));
  const continuedRate = await fetch(`${base}/api/price-lab/exchange-rate`, { headers }).then((r) => r.json());
  assert.deepEqual(continuedRate, sharedRate, "版本交接后保留系数、来源和日期");
  assert.equal(JSON.parse(await readFile(path.join(data, "exchange-rate.json"), "utf8")).manualRate.rate, 7.1234);
  states.forEach(assertPublic);
  await until(() => supervisor.state().health.consecutiveSuccesses >= 3);
  assert.equal(supervisor.state().health.lastError, null);
  for (const port of [publicPort, qualityPort]) {
    const denied = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    const passed = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-lite-ccswitch-token": "test-proxy" }, body: '{"model":"fake","input":"local"}' });
    assert.equal(passed.status, 200); await passed.text();
  }
  assert.equal(upstreamHeaders.length, 2);
  assert.ok(upstreamHeaders.every((item) => !item["x-lite-ccswitch-token"] && !item.cookie && item.authorization === "Bearer fake-upstream-key"));
  assert.ok(!events.some((line) => line.includes('"event":"health_degraded"')));
  await assert.rejects(readFile(path.join(root, "wrong-price-lab.json")), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ publicPort, qualityPort, statusSseAcrossUpgrade: true, runtimeTokenPreserved: true, privateGroupHost: "127.0.0.1", upstreamCalls: 2 }));
});
