/**
 * 用量持久化测试。
 * 验证坏行不会吞掉历史，追加写入兼容半行和多写入者，读取故障不会清空文件。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadUsageRecords, loadUsageRecordsFromOffset, appendUsageRecord } from "../../lib/usage-store.js";

test("用量日志逐行容错并保留有效记录", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-usage-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "usage.jsonl");
  await writeFile(filePath, `${JSON.stringify({ id: 1 })}\n坏掉的一行\n${JSON.stringify({ id: 2 })}\n`);

  const warnings = [];
  const loaded = await loadUsageRecords(filePath, (message) => warnings.push(message));
  assert.deepEqual(loaded.records.map((record) => record.id), [1, 2]);
  assert.equal(loaded.malformedCount, 1);
  assert.equal(warnings.length, 1);
});

test("追加日志不会覆盖半行历史，文件权限为 600", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-usage-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "usage.jsonl");
  await writeFile(filePath, '{"id":1}\n{"id":');
  await appendUsageRecord(filePath, { id: 2 });

  assert.deepEqual(
    (await loadUsageRecords(filePath, () => {})).records.map((record) => record.id),
    [1, 2],
  );
  assert.ok((await readFile(filePath, "utf8")).startsWith('{"id":1}\n{"id":\n'));
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("多个追加写入者不会互相覆盖记录", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-usage-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "usage.jsonl");
  await Promise.all(Array.from({ length: 30 }, (_, id) => appendUsageRecord(filePath, { id })));
  const loaded = await loadUsageRecords(filePath);
  assert.equal(loaded.malformedCount, 0);
  assert.equal(new Set(loaded.records.map((record) => record.id)).size, 30);
});

test("日志读取故障会抛出异常，禁止从空数据覆盖原文件", async () => {
  await assert.rejects(loadUsageRecords(tmpdir()));
});

test("追加记录只读取偏移量之后的内容，并保留不完整尾行", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-usage-tail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "usage.jsonl");
  await writeFile(filePath, `${JSON.stringify({ id: "old" })}\n`);
  const first = await loadUsageRecords(filePath, () => {});
  await appendUsageRecord(filePath, { id: "new" });
  const tail = await loadUsageRecordsFromOffset(filePath, first.offset, first.remainder, () => {});
  assert.deepEqual(tail.records.map((record) => record.id), ["new"]);
  assert.equal(tail.reset, false);

  await writeFile(filePath, `${JSON.stringify({ id: "old" })}\n{"id":`);
  const partial = await loadUsageRecordsFromOffset(filePath, first.offset, "", () => {});
  assert.deepEqual(partial.records, []);
  assert.equal(partial.remainder, '{"id":');
  await appendUsageRecord(filePath, { id: "after-partial" });
  const resumed = await loadUsageRecordsFromOffset(filePath, partial.offset, partial.remainder, () => {});
  assert.deepEqual(resumed.records.map((record) => record.id), ["after-partial"]);
});

test("文件被截断时要求完整重载，而不是从旧偏移量继续读取", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-usage-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "usage.jsonl");
  await writeFile(filePath, `${JSON.stringify({ id: "long-record" })}\n`);
  const first = await loadUsageRecords(filePath, () => {});
  await writeFile(filePath, `${JSON.stringify({ id: "short" })}\n`);
  const next = await loadUsageRecordsFromOffset(filePath, first.offset, first.remainder, () => {});
  assert.equal(next.reset, true);
});
