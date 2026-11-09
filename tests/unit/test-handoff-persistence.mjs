/**
 * 中文持久化通道测试：验证并发用量写入只落一条，旧工作进程不能覆盖新配置。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandoffPersistence } from "../../lib/handoff-persistence.js";

test("并发提交同一用量记录只写入一次", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-persistence-"));
  const data = path.join(root, "data");
  const persistence = createHandoffPersistence({ dataDir: data });
  const record = { id: "record-1", statusCode: 200, totalTokens: 3 };
  const results = await Promise.all([
    persistence.appendUsage(record, { workerId: "old" }),
    persistence.appendUsage(record, { workerId: "next" }),
  ]);
  await persistence.flush();
  const lines = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(results.filter((value) => value.deduplicated).length, 1);
});

test("配置写入只接受当前工作进程", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-persistence-config-"));
  const data = path.join(root, "data");
  const persistence = createHandoffPersistence({ dataDir: data });
  persistence.setActiveWorker("next");
  await assert.rejects(persistence.saveConfig({ version: 2 }, { workerId: "old" }), /旧交接进程/);
  await persistence.saveConfig({ version: 2, marker: "next" }, { workerId: "next" });
  assert.match(await readFile(path.join(data, "config.json"), "utf8"), /next/);
});

test("同 ID 在途写入失败时所有提交均失败，清理后可以重试", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-persistence-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const usagePath = path.join(root, "usage.jsonl");
  await mkdir(usagePath);
  const persistence = createHandoffPersistence({ dataDir: root });
  const record = { id: "retry-same-id", totalTokens: 9 };
  const results = await Promise.allSettled([persistence.appendUsage(record), persistence.appendUsage(record)]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persistence.state().pendingUsageWrites, 0);
  assert.equal(persistence.state().committedUsageIds, 0);
  await rm(usagePath, { recursive: true });
  await persistence.appendUsage(record);
  await persistence.appendUsage(record);
  assert.equal((await readFile(usagePath, "utf8")).split("\n").filter(Boolean).length, 1);
});

test("配置交接先阻止新提交，再等待已经受理的保存完成", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-persistence-barrier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistence = createHandoffPersistence({ dataDir: root });
  persistence.setActiveWorker("old");
  const accepted = persistence.saveConfig({ version: 2, marker: "最后一次旧配置" }, { workerId: "old" });
  const barrier = persistence.pauseConfigWrites();
  await assert.rejects(persistence.saveConfig({ marker: "禁止迟到覆盖" }, { workerId: "old" }), /旧交接进程/);
  await barrier;
  await accepted;
  assert.equal(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).marker, "最后一次旧配置");
  persistence.setActiveWorker("next");
  await persistence.saveConfig({ version: 2, marker: "新版本配置" }, { workerId: "next" });
  assert.equal(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).marker, "新版本配置");
});

test("已经受理的配置保存失败时，交接屏障必须报告失败", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-persistence-barrier-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  await mkdir(configPath);
  const persistence = createHandoffPersistence({ dataDir: root, configPath });
  persistence.setActiveWorker("old");
  const save = persistence.saveConfig({ version: 2 }, { workerId: "old" });
  await assert.rejects(save);
  await assert.rejects(persistence.pauseConfigWrites());
});

test("监督器重启时合并工作进程暂存用量并保留归档", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-persistence-recovery-"));
  const data = path.join(root, "data"); const pending = path.join(data, "handoff-pending-usage");
  await mkdir(pending, { recursive: true });
  await writeFile(path.join(data, "usage.jsonl"), `${JSON.stringify({ id: "existing", statusCode: 200 })}\n`);
  await writeFile(path.join(pending, "worker.jsonl"), [
    { id: "existing", statusCode: 200 },
    { id: "orphaned", statusCode: 200, handoffPending: true },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const persistence = createHandoffPersistence({ dataDir: data });
  assert.equal(await persistence.recoverPendingUsage(), 1);
  const lines = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(lines.map((record) => record.id), ["existing", "orphaned"]);
  assert.equal((await readdir(path.join(data, "release-recovery", "handoff-pending-usage"))).length, 1);
  assert.equal(await persistence.recoverPendingUsage(), 0);
  await rm(root, { recursive: true, force: true });
});

