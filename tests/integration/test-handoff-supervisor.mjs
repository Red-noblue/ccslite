/**
 * 中文固定监听监督器验收：使用真实 Lite 版本包验证长流排空、分组端口、候选接管和崩溃回退。
 * 所有版本包、数据、端口和上游均为本测试独立创建，不访问正式项目或真实供应商。
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
  const port = server.address().port; assert.ok(port >= 15725); return port;
}
async function reserve() { const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }
async function until(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(25); }
  throw new Error("等待交接监督器状态超时");
}

test("真实 Lite 工作进程完成版本接管、分组转发和崩溃回退", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-supervisor-")); const data = path.join(root, "data"); await mkdir(data, { recursive: true });
  const externalCandidate = process.env.LITE_HANDOFF_CANDIDATE || "";
  const externalFallback = process.env.LITE_HANDOFF_FALLBACK || "";
  const candidate = externalCandidate || path.join(root, "candidate"); const fallback = externalFallback || path.join(root, "fallback");
  if (!externalCandidate && !externalFallback) {
    await createReleaseSnapshot(ROOT, candidate, "handoff-candidate"); await createReleaseSnapshot(ROOT, fallback, "handoff-fallback");
  }
  const candidateId = JSON.parse(await readFile(path.join(candidate, "release-manifest.json"), "utf8")).releaseId;
  const fallbackId = JSON.parse(await readFile(path.join(fallback, "release-manifest.json"), "utf8")).releaseId;
  let upstreamCalls = 0; let releaseStream = () => {};
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); upstreamCalls += 1;
    if (body.input === "hold") {
      const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(event("response.output_text.delta", { delta: "开始" }));
      const timer = setInterval(() => res.write(event("response.output_text.delta", { delta: "继续" })), 100);
      res.once("close", () => clearInterval(timer));
      releaseStream = () => { clearInterval(timer); if (!res.destroyed) res.end(event("response.completed", { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })); };
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "completed", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream); const publicPort = await reserve(); const qualityPort = await reserve();
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] },
      { id: "quality", routingVersion: 1, name: "质量", listener: { host: "127.0.0.1", port: qualityPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const events = [];
  const supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, observeMs: 10_000, log: (line) => events.push(line) });
  t.after(async () => { releaseStream(); await supervisor.close().catch(() => {}); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await supervisor.start();
  let status = await until(async () => { try { const value = await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json()); return value.build?.releaseId === candidateId ? value : false; } catch { return false; } });
  assert.equal(status.port, publicPort); assert.equal(status.groups.find((group) => group.id === "quality").actualListener.port, qualityPort);
  const first = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "candidate" }) });
  assert.equal(first.status, 200); await first.text();
  const stream = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "hold", stream: true }) });
  const streamText = stream.text();
  const upgrading = supervisor.upgrade(fallback);
  await until(() => supervisor.listener.queue.state() === "draining");
  assert.equal(supervisor.current().id, candidateId);
  const waiting = fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "queued" }) });
  await until(() => supervisor.listener.queue.stats().queuedRequests === 1);
  await pause(100);
  assert.equal(supervisor.current().id, candidateId, "长流尚未结束时必须保持旧版本写入权");
  releaseStream(); assert.match(await streamText, /response.completed/);
  await upgrading; const queuedResponse = await waiting;
  assert.equal(queuedResponse.status, 200); await queuedResponse.text();
  status = await until(async () => { const value = await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json()); return value.build?.releaseId === fallbackId ? value : false; });
  assert.equal(status.port, publicPort);
  const quality = await fetch(`http://127.0.0.1:${qualityPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "quality" }) });
  assert.equal(quality.status, 200); await quality.text();
  await until(async () => (await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json())).handoff.pendingRequests === 0);
  const active = supervisor.current(); active.child.kill("SIGKILL");
  await until(async () => { try { const value = await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json()); return value.build?.releaseId === fallbackId && value.processId !== active.pid ? value : false; } catch { return false; } }, 10000);
  const recovered = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "recovered" }) });
  assert.equal(recovered.status, 200); await recovered.text();
  assert.equal(upstreamCalls, 5, "排队请求不能被重复发出");
  const records = await until(async () => { const lines = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean); return lines.length === 5 ? lines : false; });
  assert.ok(records.every((line) => JSON.parse(line).statusCode === 200));
  const leaseState = JSON.parse(await readFile(path.join(data, "handoff-active-worker.json"), "utf8"));
  assert.deepEqual({ state: leaseState.state, workerId: leaseState.workerId }, { state: "active", workerId: fallbackId });
  assert.equal((await readFile(path.join(data, "config.json"), "utf8")).includes("本机假上游"), true);
  const finalStream = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "hold", stream: true }) });
  const finalText = finalStream.text();
  let stopped = false;
  const stopping = supervisor.close().then(() => { stopped = true; });
  await pause(100); assert.equal(stopped, false, "首次停止必须保留活动 SSE");
  const duringClose = fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "during-close" }) });
  releaseStream(); assert.match(await finalText, /response.completed/); await stopping;
  const duringCloseResponse = await duringClose; assert.equal(duringCloseResponse.status, 200); await duringCloseResponse.text();
  const finalRecords = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean);
  assert.equal(finalRecords.length, 7, "正常停止必须等待最后一次用量落盘");
  t.diagnostic(JSON.stringify({ publicPort, qualityPort, upstreamCalls, usageRecords: finalRecords.length, recoveredRelease: fallbackId, gracefulSseStop: true, requestDuringClose: true }));
});
