/**
 * 多端口分组集成验证：独立进程与本机伪上游覆盖路由、会话、计费、动态端口和优雅关闭。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("分组端口真实转发、隔离会话与用量，热更新保留流并统一优雅关闭", { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-group-ports-"));
  const held = [];
  let failB = false;
  const upstreams = ["a", "b"].map((id) => createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}");
    if (id === "b" && failB) { res.writeHead(503); res.end("暂时不可用"); return; }
    if (payload.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: `resp-${id}` } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "测试" })}\n\n`);
      held.push(() => res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp-${id}`, usage: { input_tokens: 10, output_tokens: 2 } } })}\n\n`));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `resp-${id}`, model: payload.model, output: [{ content: [{ type: "output_text", text: "CCOK" }] }], usage: { input_tokens: 10, output_tokens: 2 } }));
    }
  }));
  const upstreamPorts = await Promise.all(upstreams.map(listen));
  const occupied = createServer();
  const occupiedPort = await listen(occupied);
  const port = await freePort(), qualityPort = await freePort();
  let nextPort;
  const base = `http://127.0.0.1:${port}`;
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    version: 2,
    proxy: { autoFailoverEnabled: true, maxAttempts: 1, preferredProviderMaxAttempts: 1, providerMaxAttempts: 1 },
    providers: upstreamPorts.map((upstreamPort, index) => ({ id: index ? "b" : "a", name: index ? "乙" : "甲", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "test", routingEnabled: true, sortIndex: index + 1 })),
    groups: [{ id: "quality", routingVersion: 1, name: "高质量", listener: { port: qualityPort }, providerRefs: [{ providerId: "b", enabled: true, sortIndex: 1 }, { providerId: "a", enabled: true, sortIndex: 2 }] }],
    connectivityTest: { periodicIntervalMs: null },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  let child;
  const start = async () => {
    child = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, stdio: "pipe", env: { ...env, LITE_CCSWITCH_DATA_DIR: root, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(port) } });
    let logs = ""; child.stdout.on("data", (chunk) => { logs += chunk; }); child.stderr.on("data", (chunk) => { logs += chunk; });
    for (let n = 0; n < 100; n += 1) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(base + "/api/status")).ok) return; } catch { /* 等待隔离服务。 */ }
      await pause(20);
    }
    throw new Error(`启动超时：${logs}`);
  };
  const stop = async () => {
    if (child?.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  };
  t.after(async () => {
    held.splice(0).forEach((finish) => finish()); await stop();
    for (const server of [...upstreams, occupied]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  });
  const api = async (url, method = "GET", body) => {
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `${url} 返回 ${response.status}`); return response.json();
  };
  const request = (targetPort, extra = {}, headers = {}) => fetch(`http://127.0.0.1:${targetPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": "same-session", ...headers }, body: JSON.stringify({ model: "test-model", input: "test", ...extra }) });
  const routed = async (targetPort, providerId, groupId, extra, headers) => {
    const response = await request(targetPort, extra, headers); assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-lite-ccswitch-provider-id"), providerId);
    assert.equal(response.headers.get("x-lite-ccswitch-group-id"), groupId);
    return response.json();
  };
  await start();
  let quality = (await api("/api/groups")).find((group) => group.id === "quality");
  assert.equal(quality.actualListener.port, qualityPort);
  assert.equal(quality.listenerStatus, "listening");
  await routed(qualityPort, "b", "quality");
  await routed(port, "a", "default", {}, { "x-lite-ccswitch-group-id": "quality" });
  await routed(port, "a", "default", { previous_response_id: "resp-b" });
  for (let n = 0; n < 100; n += 1) {
    quality = (await api("/api/groups")).find((group) => group.id === "quality");
    if (quality.statistics.successRequests === 1) break; await pause(10);
  }
  assert.equal(quality.statistics.totalRequests, 1);
  assert.equal((await api("/api/billing/summary?groupId=quality")).business.totalRequests, 1);
  assert.equal((await api("/api/billing/summary?groupId=default")).business.totalRequests, 2);
  assert.ok(quality.providerActivity.providers.every((provider) => provider.providerId === "b"));
  await api("/api/providers/b", "PUT", { routingEnabled: false });
  await routed(qualityPort, "b", "quality");
  const empty = await api("/api/groups", "POST", { name: "空分组", providerRefs: [] });
  assert.equal(empty.listenerStatus, "listening");
  const emptyResponse = await request(empty.actualListener.port); assert.equal(emptyResponse.status, 503); await emptyResponse.text();
  const copy = await api("/api/groups/default/clone", "POST");
  assert.equal(copy.statistics.totalRequests, 0);
  assert.equal(copy.providerRefs.find((ref) => ref.providerId === "b").enabled, false);
  await routed(copy.actualListener.port, "a", copy.id);
  await api("/api/groups/quality", "PUT", { routing: { autoFailoverEnabled: false } });
  assert.equal((await api("/api/status")).proxy.autoFailoverEnabled, true);
  await api("/api/providers/a?groupId=quality", "PUT", { routingEnabled: false });
  await api("/api/providers/a/select?groupId=quality", "POST");
  await routed(qualityPort, "a", "quality");
  await api("/api/groups/quality", "PUT", { routing: { autoFailoverEnabled: true } });
  await api("/api/providers/a?groupId=quality", "PUT", { routingEnabled: false });
  assert.equal((await api("/api/providers")).find((provider) => provider.id === "a").routingEnabled, true);
  failB = true;
  const failed = await request(qualityPort); assert.equal(failed.status, 503); await failed.text();
  await routed(port, "a", "default"); failB = false;
  const rejected = await fetch(base + "/api/groups/quality", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ listener: { port: occupiedPort } }) });
  assert.equal(rejected.status, 409);
  quality = await api("/api/groups/quality"); assert.equal(quality.listener.port, qualityPort); assert.equal(quality.actualListener.port, qualityPort);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).groups.find((group) => group.id === "quality").listener.port, qualityPort);
  const stream = await request(qualityPort, { stream: true });
  for (let n = 0; n < 100 && held.length < 1; n += 1) await pause(10);
  assert.equal(held.length, 1);
  assert.equal(stream.status, 200);
  nextPort = await freePort();
  await api("/api/groups/quality", "PUT", { listener: { port: nextPort } });
  await assert.rejects(fetch(`http://127.0.0.1:${qualityPort}/v1/responses`));
  await routed(nextPort, "b", "quality");
  held.shift()(); assert.match(await stream.text(), /response.completed/);
  await api("/api/groups/quality", "PUT", { listener: { enabled: false } });
  assert.equal((await api("/api/groups/quality")).actualListener, null);
  await assert.rejects(fetch(`http://127.0.0.1:${nextPort}/v1/responses`));
  await api("/api/groups/quality", "PUT", { listener: { enabled: true } });
  const publicGroup = await api("/api/groups", "POST", { name: "公网访问控制", listener: { host: "0.0.0.0", port: await freePort() }, providerRefs: [{ providerId: "a", enabled: true }] });
  const denied = await request(publicGroup.actualListener.port); assert.equal(denied.status, 503); await denied.text();
  await api(`/api/groups/${publicGroup.id}`, "PUT", { listener: { enabled: false } });
  await stop(); await start();
  quality = await api("/api/groups/quality"); assert.equal(quality.actualListener.port, nextPort); assert.ok(quality.statistics.totalRequests >= 4);
  const defaultStream = await request(port, { stream: true });
  const qualityStream = await request(nextPort, { stream: true });
  for (let n = 0; n < 100 && held.length < 2; n += 1) await pause(10);
  assert.equal(held.length, 2);
  const exited = once(child, "exit"); child.kill("SIGTERM"); await pause(100);
  assert.equal(child.exitCode, null, "排空期间必须等待所有端口的活动流");
  held.splice(0).forEach((finish) => finish());
  assert.match(await defaultStream.text(), /response.completed/); assert.match(await qualityStream.text(), /response.completed/);
  assert.equal((await exited)[0], 0);
});
