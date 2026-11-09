/**
 * 中文会话级在线交接验收：验证新会话进入候选版本、旧会话继续完成，
 * 并在完整响应结束后把同一会话的下一次请求迁移到候选版本。
 * 测试不使用正式端口、正式数据或真实供应商。
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
  const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port;
}
async function until(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error("等待会话交接状态超时");
}

test("两个并行会话可以逐步交接，旧会话下一次请求进入新版本", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-session-handoff-"));
  const data = path.join(root, "data"); await mkdir(data, { recursive: true });
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "session-old");
  await createReleaseSnapshot(ROOT, fallback, "session-new");
  const next = path.join(root, "next"); await createReleaseSnapshot(ROOT, next, "session-target");
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const id = `resp-${payload.input || "request"}-${Date.now()}`;
    if (payload.input === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "开始" })}\n\n`);
      const timer = setInterval(() => res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "继续" })}\n\n`), 40);
      const finish = () => { clearInterval(timer); if (!res.destroyed) res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`); };
      upstream.releaseHold = finish;
      res.once("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, status: "completed", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const publicPort = await reserve();
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "测试上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }],
    connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, observeMs: 60_000 });
  t.after(async () => { upstream.releaseHold?.(); await supervisor.close().catch(() => {}); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await supervisor.start();
  await until(async () => (await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json())).build?.releaseId === "session-old");

  const oldStream = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": "A" }, body: JSON.stringify({ model: "fake", input: "hold", stream: true }) });
  assert.equal(oldStream.status, 200);
  const oldText = oldStream.text();
  await pause(120);
  const upgrade = supervisor.upgradeSession(next);
  await until(() => supervisor.state().phase === "active_parallel");
  assert.equal((await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json())).build.releaseId, "session-target");

  const newSession = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": "B" }, body: JSON.stringify({ model: "fake", input: "new", stream: false }) });
  assert.equal(newSession.status, 200); await newSession.text();
  const concurrentOld = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": "A" }, body: JSON.stringify({ model: "fake", input: "old-concurrent", stream: false }) });
  assert.equal(concurrentOld.status, 200); await concurrentOld.text();
  assert.equal(supervisor.current().id, "session-target");

  upstream.releaseHold?.();
  assert.match(await oldText, /response.completed/);
  await upgrade;
  await until(() => supervisor.listener.sessionState().legacySessionCount === 0);
  const migrated = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": "A" }, body: JSON.stringify({ model: "fake", input: "after", stream: false }) });
  assert.equal(migrated.status, 200); await migrated.text();
  const records = await until(async () => {
    const lines = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean);
    return lines.length === 4 ? lines : false;
  });
  assert.equal(records.length, 4);
  assert.ok(records.every((line) => JSON.parse(line).statusCode === 200));
  const failedCandidate = supervisor.current();
  failedCandidate.child.kill("SIGKILL");
  await until(async () => (await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json()).catch(() => null))?.build?.releaseId === "session-new");
  const recovered = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": "B" }, body: JSON.stringify({ model: "fake", input: "after-crash", stream: false }) });
  assert.equal(recovered.status, 200); await recovered.text();
  const finalRecords = await until(async () => {
    const lines = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean);
    return lines.length === 5 ? lines : false;
  });
  assert.equal(finalRecords.length, 5);
  t.diagnostic(JSON.stringify({ mode: supervisor.listener.sessionState().mode, records: finalRecords.length, current: supervisor.current().id, rollback: true }));
});

