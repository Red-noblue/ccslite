/**
 * 中文观察期后恢复验收：旧进程退役后仍保留版本包，可手动回退并在当前进程崩溃时重新接管。
 * 只使用测试自有进程、数据和本机假上游，不访问正式服务或真实供应商。
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
async function until(check) {
  for (let i = 0; i < 600; i += 1) { const value = await check(); if (value) return value; await pause(10); }
  throw new Error("等待观察期后回退超时");
}

test("旧进程退役后仍可手动回退，崩溃时重新启动回退包并接管队列", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-cold-")); const data = path.join(root, "data"); await mkdir(data);
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "cold-a"); await createReleaseSnapshot(ROOT, fallback, "cold-b");
  const next = path.join(root, "next"); await createReleaseSnapshot(ROOT, next, "cold-c");
  let calls = 0; const upstream = createServer(async (req, res) => { for await (const chunk of req) { void chunk; } calls += 1; res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}'); });
  const upstreamPort = await listen(upstream); const publicPort = await reserve(); const qualityPort = await reserve();
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] },
      { id: "quality", name: "质量", listener: { host: "127.0.0.1", port: qualityPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const events = []; const supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, observeMs: 60,
    healthPolicy: { intervalMs: 30, timeoutMs: 300 }, log: (line) => events.push(line) });
  t.after(async () => { await supervisor.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = async (port = publicPort) => { const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "normal" }) }); assert.equal(response.status, 200); await response.text(); };
  const retired = () => until(() => !supervisor.state().previous && supervisor.state().liveWorkers === 1);
  await supervisor.start(); await request();
  await supervisor.upgrade(next); await request(qualityPort); await retired();
  const beforeManual = supervisor.current().pid;
  await supervisor.rollback("观察期后手动回退"); assert.equal(supervisor.current().id, "cold-b"); assert.notEqual(supervisor.current().pid, beforeManual); await request(); await retired();
  await supervisor.upgrade(next); await request(qualityPort); await retired();
  await until(async () => (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).length === 4);
  const recoveryCount = () => events.filter((line) => line.includes('"event":"handoff_recovery_started"')).length;
  const beforeRecovery = recoveryCount();
  const killed = supervisor.current(); const startedAt = Date.now(); killed.child.kill("SIGKILL");
  await until(() => recoveryCount() > beforeRecovery);
  const queued = request(qualityPort);
  await until(() => supervisor.listener.queue.stats().queuedRequests === 1 || supervisor.current().id === "cold-b");
  await queued; const elapsedMs = Date.now() - startedAt;
  assert.equal(supervisor.current().id, "cold-b"); assert.notEqual(supervisor.current().pid, killed.pid); assert.ok(elapsedMs < 10000);
  await supervisor.close();
  const records = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(calls, 5); assert.equal(records.length, 5); assert.ok(records.every((record) => record.statusCode === 200));
  t.diagnostic(JSON.stringify({ upstreamCalls: calls, usageRecords: records.length, coldManualRollback: true, coldCrashRecovery: true, elapsedMs }));
});

test("回退进程尚未稳定就再次崩溃时停止自动重试，公开端口报告受控故障", { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-recovery-limit-")); let supervisor;
  t.after(async () => { await supervisor?.close(); await rm(root, { recursive: true, force: true }); });
  const data = path.join(root, "data"); await mkdir(data);
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "limit-a"); await createReleaseSnapshot(ROOT, fallback, "limit-b"); const publicPort = await reserve();
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, providers: [], groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [] }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const events = []; supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, observeMs: 30000, healthPolicy: { intervalMs: 30 }, log: (line) => events.push(line) });
  await supervisor.start(); await supervisor.upgrade(fallback);
  const first = supervisor.current(); first.child.kill("SIGKILL");
  await until(() => supervisor.current().id === "limit-b" && supervisor.current().pid !== first.pid && supervisor.state().operation === null);
  const second = supervisor.current(); second.child.kill("SIGKILL"); await until(() => supervisor.state().phase === "failed");
  const response = await fetch(`http://127.0.0.1:${publicPort}/api/status`); assert.equal(response.status, 503); assert.equal((await response.json()).error.type, "handoff_recovery_exhausted");
  await pause(100); assert.equal(supervisor.current().pid, second.pid); assert.equal(supervisor.state().liveWorkers, 0);
  assert.equal(events.filter((line) => line.includes('"event":"handoff_recovery_exhausted"')).length, 1);
  t.diagnostic(JSON.stringify({ consecutiveCrashes: 2, automaticRecoveries: 1, controlledStatus: 503, processRestartLoopPrevented: true }));
});
