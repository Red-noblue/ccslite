/**
 * 中文固定监听启动回退验收：旧的非交接候选无法通过工作进程身份检查时，保留公开监听并启动固定监听回退包。
 * 使用独立数据和端口，不访问正式服务或真实供应商。
 * 整场景预留 120 秒复制和校验依赖，避免云端磁盘速度影响回退行为验收。
 */
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error("启动回退状态等待超时");
}

test("固定监听候选启动失败时清理进程并启动回退包", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-boot-fallback-"));
  const candidate = path.join(root, "bad");
  const fallback = path.join(root, "fallback");
  const fakeSource = path.join(root, "fake-source");
  await mkdir(path.join(fakeSource, "public"), { recursive: true });
  await mkdir(path.join(fakeSource, "lib"));
  await writeFile(path.join(fakeSource, "lib/fixture.js"), "// 中文测试占位：让失败包具备可核对的代码身份，仍由 server.js 启动后主动退出。\n");
  await writeFile(path.join(fakeSource, "server.js"), '// 中文测试候选：启动后立即退出，不读取或写入数据。\nprocess.exit(1);\n');
  await writeFile(path.join(fakeSource, "package.json"), '{"version":"0.0.0","type":"module"}');
  await writeFile(path.join(fakeSource, "package-lock.json"), '{}');
  await writeFile(path.join(fakeSource, "public/index.html"), '<html lang="zh-CN"></html>');
  await createReleaseSnapshot(fakeSource, candidate, "bad-candidate");
  await createReleaseSnapshot(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."), fallback, "good-fallback");
  const data = path.join(root, "data"); await mkdir(data, { recursive: true });
  const guard = createServer();
  await new Promise((resolve) => guard.listen(0, "127.0.0.1", resolve));
  const publicPort = guard.address().port;
  await new Promise((resolve) => guard.close(resolve));
  assert.ok(publicPort >= 15725);
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false }, providers: [],
    groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [] }],
    connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, observeMs: 1000 });
  t.after(async () => { await supervisor.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await supervisor.start();
  const status = await until(async () => { try { const value = await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json()); return value.build?.releaseId || false; } catch { return false; } });
  const fallbackId = JSON.parse(await readFile(path.join(fallback, "release-manifest.json"), "utf8")).releaseId;
  assert.equal(status, fallbackId);
  assert.equal(supervisor.coordinator.state().current, fallbackId);
  assert.equal(supervisor.listener.target().id, fallbackId);
});

test("候选预热成功但激活失败时清理候选，回退仍保留历史数据", { timeout: 120_000 }, async (t) => {
  const setupStartedAt = Date.now();
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-activation-"));
  let supervisor; t.after(async () => { await supervisor?.close(); await rm(root, { recursive: true, force: true }); });
  const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const fixture = path.join(root, "fixture"); await mkdir(fixture);
  for (const name of ["lib", "node_modules", "public"]) await cp(path.join(sourceRoot, name), path.join(fixture, name), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "VERSION.json"]) await copyFile(path.join(sourceRoot, name), path.join(fixture, name));
  const server = await readFile(path.join(sourceRoot, "server.js"), "utf8");
  const signature = "async function activateHandoffWorker() {"; assert.equal(server.split(signature).length, 2);
  await writeFile(path.join(fixture, "server.js"), server.replace(signature, `${signature}\n  throw new Error("测试注入：候选激活失败");`));
  const candidate = path.join(root, "bad"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(fixture, candidate, "activation-bad"); await createReleaseSnapshot(sourceRoot, fallback, "activation-good");
  t.diagnostic(JSON.stringify({ snapshotSetupMs: Date.now() - setupStartedAt }));
  const data = path.join(root, "data"); await mkdir(data);
  const guard = createServer(); await new Promise((resolve) => guard.listen(0, "127.0.0.1", resolve)); const publicPort = guard.address().port; await new Promise((resolve) => guard.close(resolve)); assert.ok(publicPort >= 15725);
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, providers: [],
    groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [] }], connectivityTest: { periodicIntervalMs: null } }));
  const history = JSON.stringify({ id: "history", statusCode: 200, model: "fake", inputTokens: 1 }) + "\n";
  await writeFile(path.join(data, "usage.jsonl"), history); const before = await readFile(path.join(data, "config.json"), "utf8");
  await assert.rejects(createHandoffSupervisor({ candidate, fallback, dataDir: candidate, publicPort }), /数据目录必须与版本包完全分开/);
  await assert.rejects(createHandoffSupervisor({ candidate, fallback: candidate, dataDir: data, publicPort }), /两个独立版本包/);
  const events = []; supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, log: (line) => events.push(line) });
  const worker = await supervisor.start(); assert.equal(worker.id, "activation-good"); assert.equal(supervisor.state().liveWorkers, 1);
  const status = await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((response) => response.json());
  assert.equal(status.handoff.readOnly, false); assert.equal(status.build.releaseId, "activation-good");
  assert.equal(await readFile(path.join(data, "usage.jsonl"), "utf8"), history);
  assert.equal(await readFile(path.join(data, "config.json"), "utf8"), before);
  assert.ok(events.some((line) => line.includes("候选激活失败")));
  t.diagnostic(JSON.stringify({ activationFailureFallback: true, candidateCleaned: true, configUnchanged: true, historicalUsageUnchanged: true }));
});
