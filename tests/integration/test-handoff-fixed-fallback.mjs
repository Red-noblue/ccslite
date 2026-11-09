/**
 * 中文固定备份与配置屏障验收：延迟旧配置保存，同时升级、提交新配置并回退。
 * 三个会话分别留在旧版和新版，验证备份接管后原请求仍可完成且用量不重放。
 * 仅使用独立代码、数据、15725 以上随机端口和本机假上游。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(20); }
  throw new Error("固定备份或配置屏障验收等待超时");
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  assert.ok(server.address().port >= 15725);
  return server.address().port;
}

test("配置保存与升级重叠时不丢修改，固定备份接管后多个旧流仍完整结束", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-fixed-fallback-"));
  const data = path.join(root, "data"); await mkdir(data);
  const fixture = path.join(root, "delayed-source"); await mkdir(fixture);
  for (const name of ["lib", "node_modules", "public", "package.json", "package-lock.json"]) {
    await cp(path.join(ROOT, name), path.join(fixture, name), { recursive: true });
  }
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  const signature = "async function saveConfig(nextConfig, { operationId = null } = {}) {";
  assert.equal(source.split(signature).length, 2);
  const delaySave = `
  // 中文测试注入：让已经受理的配置保存等待测试放行，以稳定复现交接竞争。
  if (!handoffReadOnly && !handoffContinuation && nextConfig.proxy?.preferredProviderMaxAttempts === 19) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(DATA_DIR, "save-entered"), "1");
    while (!await fs.stat(path.join(DATA_DIR, "save-release")).then(() => true, () => false)) await delay(20);
  }
`;
  await writeFile(path.join(fixture, "server.js"), source.replace(signature, signature + delaySave));
  const original = path.join(root, "original"), candidate = path.join(root, "candidate"), fallback = path.join(root, "fallback");
  await createReleaseSnapshot(fixture, original, "original-a");
  await createReleaseSnapshot(ROOT, candidate, "candidate-b");
  await createReleaseSnapshot(process.env.LITE_HANDOFF_BASELINE || ROOT, fallback, "fixed-f");
  const holds = new Map(); let calls = 0; let supervisor;
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls += 1;
    const id = `resp-${body.input}`;
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`);
      const timer = setInterval(() => res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"继续"}\n\n'), 40);
      const finish = () => { clearInterval(timer); if (!res.destroyed) res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`); };
      holds.set(body.input, finish); res.once("close", () => clearInterval(timer));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, status: "completed", usage: { input_tokens: 1, output_tokens: 1 } }));
    }
  });
  t.after(async () => {
    await writeFile(path.join(data, "save-release"), "1");
    for (const finish of holds.values()) finish();
    await supervisor?.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const upstreamPort = await listen(upstream);
  const guard = createServer(); const publicPort = await listen(guard); await new Promise((resolve) => guard.close(resolve));
  const groupGuard = createServer(); const groupPort = await listen(groupGuard); await new Promise((resolve) => groupGuard.close(resolve));
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2,
    proxy: { autoFailoverEnabled: false, currentProviderId: "local" },
    providers: [{ id: "local", name: "独立假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }],
    connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  supervisor = await createHandoffSupervisor({ candidate: original, fallback, dataDir: data, publicPort, observeMs: 60000, log: () => {} });
  await supervisor.start();
  const request = (session, input, stream = false) => fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": session }, body: JSON.stringify({ model: "fake", input, stream }) });
  const save = (proxy) => fetch(`http://127.0.0.1:${publicPort}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ proxy }) });
  const a = await request("A", "hold-a", true), a2 = await request("A2", "hold-a2", true);
  assert.equal(a.status, 200); assert.equal(a2.status, 200);
  const aText = a.text(), a2Text = a2.text();
  const oldSave = save({ preferredProviderMaxAttempts: 19 });
  await until(() => readFile(path.join(data, "save-entered")).then(() => true, () => false));
  const upgrading = supervisor.upgradeSession(candidate);
  await until(() => supervisor.listener.adminQueue.state() === "draining");
  const newSave = save({ providerMaxAttempts: 3 });
  await until(() => supervisor.listener.adminQueue.stats().queuedRequests === 1);
  const groupSave = fetch(`http://127.0.0.1:${publicPort}/api/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "交接期间新增", sourceGroupId: "default", listener: { host: "127.0.0.1", port: groupPort, enabled: true } }) });
  await until(() => supervisor.listener.adminQueue.stats().queuedRequests === 2);
  assert.equal(supervisor.current().id, "original-a");
  await writeFile(path.join(data, "save-release"), "1");
  assert.equal((await oldSave).status, 200); await upgrading;
  assert.equal((await newSave).status, 200);
  assert.equal((await groupSave).status, 201);
  assert.equal(supervisor.state().session.mode, "session", "新增分组不能取消旧会话的逐请求交接");
  const running = await fetch(`http://127.0.0.1:${publicPort}/api/config`).then((res) => res.json());
  assert.equal(running.proxy.preferredProviderMaxAttempts, 19); assert.equal(running.proxy.providerMaxAttempts, 3);
  assert.equal(supervisor.state().rollbackRoot, await realpath(fallback));
  const b = await request("B", "hold-b", true); assert.equal(b.status, 200); const bText = b.text();
  const rollback = supervisor.rollback("验证固定备份接管");
  await until(() => supervisor.state().phase === "recovering");
  const queued = request("C", "during-rollback");
  await until(() => supervisor.listener.queue.stats().queuedRequests === 1);
  const queuedSave = save({ maxAttempts: 28 });
  await rollback;
  assert.equal(supervisor.current().id, "fixed-f", "不能自动选择升级前的 A");
  const resumed = await queued; assert.equal(resumed.status, 200); await resumed.text();
  assert.equal((await queuedSave).status, 200);
  const disk = JSON.parse(await readFile(path.join(data, "config.json"), "utf8"));
  assert.equal(disk.proxy.preferredProviderMaxAttempts, 19); assert.equal(disk.proxy.providerMaxAttempts, 3); assert.equal(disk.proxy.maxAttempts, 28);
  const groupRequest = await fetch(`http://127.0.0.1:${groupPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "group-after-rollback" }) });
  assert.equal(groupRequest.status, 200); await groupRequest.text();
  for (const name of ["hold-a", "hold-b", "hold-a2"]) holds.get(name)();
  for (const text of await Promise.all([aText, bText, a2Text])) assert.match(text, /response.completed/);
  await until(() => supervisor.state().liveWorkers === 1);
  const records = await until(async () => {
    const rows = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    return rows.length === 5 ? rows : false;
  });
  assert.equal(calls, 5); assert.equal(new Set(records.map((row) => row.id)).size, 5);
  assert.ok(records.every((row) => row.statusCode === 200));
  // 再从真实旧基线升级并模拟新进程崩溃，确认固定备份与最新数据可以往返使用。
  await supervisor.upgradeSession(candidate);
  const crashed = supervisor.current(); crashed.child.kill("SIGKILL");
  await until(() => supervisor.listener.queue.state() === "draining");
  const afterCrash = await request("D", "after-crash"); assert.equal(afterCrash.status, 200); await afterCrash.text();
  assert.equal(supervisor.current().id, "fixed-f");
  await until(() => supervisor.state().liveWorkers === 1);
  const finalRows = await until(async () => {
    const rows = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    return rows.length === 6 ? rows : false;
  });
  assert.equal(calls, 6); assert.equal(new Set(finalRows.map((row) => row.id)).size, 6);
  const finalConfig = JSON.parse(await readFile(path.join(data, "config.json"), "utf8"));
  assert.equal(finalConfig.proxy.preferredProviderMaxAttempts, 19); assert.equal(finalConfig.proxy.providerMaxAttempts, 3); assert.equal(finalConfig.proxy.maxAttempts, 28);
  t.diagnostic(JSON.stringify({ fixedFallback: true, delayedConfigPreserved: true, queuedConfigPreserved: true, queuedGroupPreserved: true, completedStreams: 3, crossVersionRoundtrip: true, crashRecovery: true, usageRecords: finalRows.length, replayedRequests: calls - finalRows.length }));
});
