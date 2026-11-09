/**
 * 中文交接事件查询测试：合并当前日志与归档，并支持事件过滤和尾部读取。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readHandoffEvents } from "../../lib/handoff-events-cli.js";

test("交接事件查询读取归档并返回最近事件", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "handoff-events.20261101-000000-1.jsonl"), `${JSON.stringify({ event: "handoff_activated", sequence: 1 })}\n`);
  await writeFile(path.join(root, "handoff-events.jsonl"), `${JSON.stringify({ event: "handoff_usage_committed", sequence: 2 })}\n${JSON.stringify({ event: "handoff_activated", sequence: 3 })}\n`);

  const all = await readHandoffEvents(root, { tail: 2 });
  assert.equal(all.count, 3);
  assert.deepEqual(all.events.map((entry) => entry.sequence), [2, 3]);
  assert.equal(all.invalidLines, 0);

  const filtered = await readHandoffEvents(root, { event: "handoff_usage_committed", tail: 10 });
  assert.deepEqual(filtered.events.map((entry) => entry.sequence), [2]);
});
