/**
 * 中文交接事件日志测试：验证请求完成汇总、批量写入、轮换和文件权限。
 */
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandoffJournal } from "../../lib/handoff-journal.js";

test("请求完成事件按时间和数量汇总，生命周期事件仍保留", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-journal-"));
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = createHandoffJournal({ directory: root, supervisorPid: 1234, intervalMs: 60_000, batchSize: 100 });
  journal.record({ event: "handoff_activated", worker: "v1" });
  for (let index = 0; index < 3; index += 1) journal.record({ event: "handoff_request_finished", queuedRequests: index, queuedBytes: index * 2, inFlight: index + 1 });
  await journal.flush();
  const entries = (await readFile(path.join(root, "handoff-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.filter((entry) => entry.event === "handoff_request_finished").length, 0);
  const summary = entries.find((entry) => entry.event === "handoff_request_summary");
  assert.equal(summary.completedRequests, 3);
  assert.equal(summary.maxInFlight, 3);
  assert.equal(summary.maxQueuedRequests, 2);
  assert.equal(summary.maxQueuedBytes, 4);
  assert.equal(entries.find((entry) => entry.event === "handoff_activated").supervisorPid, 1234);
  assert.equal(journal.state().pendingEvents, 0);
  await journal.close();
});

test("当前日志超过大小限制时轮换为权限受限的归档文件", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = createHandoffJournal({ directory: root, supervisorPid: 5678, intervalMs: 60_000, batchSize: 100, maxBytes: 180 });
  for (let index = 0; index < 8; index += 1) journal.record({ event: "handoff_lifecycle", index, message: "用于触发日志轮换的测试记录" });
  await journal.close();
  const files = await readdir(root);
  const archives = files.filter((name) => name.startsWith("handoff-events.") && name.endsWith(".jsonl"));
  assert.ok(archives.length >= 1);
  for (const file of ["handoff-events.jsonl", ...archives]) assert.equal((await lstat(path.join(root, file))).mode & 0o777, 0o600);
  assert.ok(journal.state().archiveCount >= 1);
});
