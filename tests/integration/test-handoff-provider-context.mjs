/**
 * 中文会话供应商上下文交接验收：升级和固定备份回退后，previous_response_id 仍先路由至原供应商。
 * 使用临时版本包、独立数据目录和本机模拟供应商，不访问正式服务或真实账号。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}
async function reserve() {
  const server = createServer(); const port = await listen(server);
  await new Promise((resolve) => server.close(resolve)); return port;
}
async function until(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error("等待供应商上下文交接状态超时");
}
function request(port, sessionId, payload, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": sessionId, ...headers },
    body: JSON.stringify(payload),
  });
}

test("版本升级保留 previous_response_id 上下文，旧固定回退包仍可故障转移完成请求", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-provider-context-"));
  const data = path.join(root, "data"); await mkdir(data, { recursive: true });
  const candidate = path.join(root, "candidate");
  const fallback = path.join(root, "fallback");
  const next = path.join(root, "next");
  await createReleaseSnapshot(ROOT, candidate, "context-old");
  const fixedFallback = process.env.LITE_CCSWITCH_TEST_FALLBACK;
  if (fixedFallback) await createReleaseSnapshot(path.resolve(fixedFallback), fallback, "context-fallback");
  else await createReleaseSnapshot(ROOT, fallback, "context-fallback");
  await createReleaseSnapshot(ROOT, next, "context-candidate");

  const calls = [];
  let releaseHold = () => {};
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const providerId = req.headers.authorization === "Bearer key-a" ? "provider-a" : "provider-b";
    calls.push({ providerId, payload });
    if (payload.input === "hold") {
      const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(event("response.created", { response: { id: "resp-hold" } }));
      res.write(event("response.output_text.delta", { delta: "等待交接" }));
      releaseHold = () => {
        if (!res.destroyed) res.end(event("response.completed", {
          response: { id: "resp-hold", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
        }));
      };
      return;
    }
    const expectedProvider = payload.previous_response_id === "resp-from-a" ? "provider-a"
      : payload.previous_response_id === "resp-from-b" ? "provider-b" : "";
    if (expectedProvider && providerId !== expectedProvider) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "previous_response_id not found" } })); return;
    }
    const id = payload.input === "create-a" ? "resp-from-a"
      : payload.input === "create-b" ? "resp-from-b"
        : `resp-${providerId}-${payload.input || "request"}`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, status: "completed", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const publicPort = await reserve();
  const providers = [
    { id: "provider-a", name: "供应商 A", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "key-a", authMode: "api_key", routingEnabled: true, sortIndex: 1 },
    { id: "provider-b", name: "供应商 B", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "key-b", authMode: "api_key", routingEnabled: true, sortIndex: 2 },
  ];
  const providerRefs = [
    { providerId: "provider-a", enabled: true, sortIndex: 1 },
    { providerId: "provider-b", enabled: true, sortIndex: 2 },
  ];
  await writeFile(path.join(data, "config.json"), JSON.stringify({
    version: 2,
    proxy: { autoFailoverEnabled: true },
    providers,
    groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs }],
    connectivityTest: { periodicIntervalMs: null },
  }));
  await writeFile(path.join(data, "usage.jsonl"), "");

  const supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, observeMs: 60_000 });
  t.after(async () => {
    releaseHold(); await supervisor.close().catch(() => {}); upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true });
  });
  await supervisor.start();
  await until(async () => (await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((response) => response.json())).build?.releaseId === "context-old");

  const first = await request(publicPort, "session-a", { model: "fake-model", input: "create-a" });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).id, "resp-from-a");

  const held = await request(publicPort, "session-hold", { model: "fake-model", input: "hold", stream: true });
  assert.equal(held.status, 200);
  const heldText = held.text();
  const upgrading = supervisor.upgradeSession(next);
  await until(() => supervisor.state().phase === "active_parallel");
  const updateGroup = (providerIds) => fetch(`http://127.0.0.1:${publicPort}/api/groups/default`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerRefs: providerIds.map((providerId, index) => ({ providerId, enabled: true, sortIndex: index + 1 })) }),
  });
  const forgedContext = Buffer.from(JSON.stringify({ providerId: "provider-b", fallbackProviderIds: [] })).toString("base64url");
  const continuedA = await request(publicPort, "session-a", {
    model: "fake-model", input: "continue-a", previous_response_id: "resp-from-a",
  }, { "x-lite-handoff-response-context": forgedContext });
  assert.equal(continuedA.status, 200);
  await continuedA.json();
  assert.deepEqual(calls.filter((call) => call.payload.previous_response_id === "resp-from-a").map((call) => call.providerId), ["provider-a"]);

  const onlyB = await updateGroup(["provider-b"]);
  assert.equal(onlyB.status, 200);
  const priorityProbe = await request(publicPort, "session-new", { model: "fake-model", input: "create-b" });
  assert.equal(priorityProbe.status, 200);
  assert.equal((await priorityProbe.json()).id, "resp-from-b");
  assert.deepEqual(calls.filter((call) => call.payload.input === "create-b").map((call) => call.providerId), ["provider-b"]);
  await until(() => supervisor.listener.resolveResponseContext("resp-from-b", "fake-model"));
  assert.deepEqual(supervisor.listener.resolveResponseContext("resp-from-b", "fake-model"), {
    providerId: "provider-b",
    fallbackProviderIds: [],
  });

  releaseHold();
  assert.match(await heldText, /response.completed/);
  await upgrading;
  await until(() => supervisor.listener.sessionState().legacySessionCount === 0);

  const restoredPriority = await updateGroup(["provider-a", "provider-b"]);
  assert.equal(restoredPriority.status, 200);
  const failed = supervisor.current();
  failed.child.kill("SIGKILL");
  await until(async () => (await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((response) => response.json()).catch(() => null))?.build?.releaseId === "context-fallback");

  const continuedB = await request(publicPort, "session-new", {
    model: "fake-model", input: "continue-b", previous_response_id: "resp-from-b",
  });
  assert.equal(continuedB.status, 200);
  await continuedB.json();
  await until(() => supervisor.listener.resolveResponseContext("resp-from-b", "fake-model"));
  assert.deepEqual(supervisor.listener.resolveResponseContext("resp-from-b", "fake-model"), {
    providerId: "provider-b",
    fallbackProviderIds: [],
  });
  const rollbackAttempts = calls.filter((call) => call.payload.previous_response_id === "resp-from-b").map((call) => call.providerId);
  if (fixedFallback) assert.equal(rollbackAttempts.at(-1), "provider-b", JSON.stringify(calls));
  else assert.deepEqual(rollbackAttempts, ["provider-b"], JSON.stringify(calls));
  const records = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(records.every((record) => record.statusCode === 200));
  t.diagnostic(JSON.stringify({
    upgradedContext: "provider-a",
    rollbackContext: "provider-b",
    rollbackAttempts,
    rollbackMode: fixedFallback ? "legacy-failover" : "context-aware",
    requestCount: calls.length,
    usageRecords: records.length,
  }));
});
