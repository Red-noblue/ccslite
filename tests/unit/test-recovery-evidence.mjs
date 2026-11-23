/** 恢复事件归档验收：并行不可变写入、跨重启读取、分组隔离、按日期分页及失败不影响业务。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecoveryEvidence } from "../../lib/recovery-evidence.js";

test("新旧版本并行保存低频事件，读取隔离且不保存动态认证或正文", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "lite-recovery-evidence-"));
  try {
    const a = createRecoveryEvidence(data), b = createRecoveryEvidence(data);
    const sample = { groupId: "default", kind: "confirmed", providerId: "a", providerName: "甲", model: "model", successCount: 2, source: "business", apiKey: "never-save", message: "never-save", request: { text: "never-save" } };
    const ids = Array.from({ length: 35 }, (_, index) => (index % 2 ? a : b).record(sample));
    await Promise.all([a.flush(), b.flush()]);
    assert.equal(new Set(ids).size, 35);
    const reopened = createRecoveryEvidence(data);
    assert.equal((await reopened.list("default")).events.length, 30);
    assert.equal((await reopened.list("default", { page: 2 })).events.length, 5);
    assert.equal((await reopened.list("other")).total, 0);
    assert.equal(await reopened.read("other", ids[0]), null);
    assert.equal(await reopened.read("default", "../../config"), null);
    const stored = await reopened.read("default", ids[0]);
    assert.equal(stored.successCount, 2); assert.doesNotMatch(JSON.stringify(stored), /never-save|apiKey|request"/);
    await assert.rejects(reopened.list("default", { day: "../../" }), /日期格式/);
    assert.equal((await reopened.list("default", { day: "2020-01-01" })).total, 0);
    assert.deepEqual(a.state(), { pendingWrites: 0, lastWriteError: null });
  } finally { await rm(data, { recursive: true, force: true }); }
});

test("归档软链接被拒绝，写入失败保留状态提示且不抛出到业务", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "lite-recovery-evidence-links-"));
  try {
    await mkdir(path.join(data, "outside")); await symlink(path.join(data, "outside"), path.join(data, "routing-evidence"));
    const store = createRecoveryEvidence(data);
    const id = store.record({ groupId: "default", providerId: "a", kind: "confirmed", model: "m" });
    await store.flush(); assert.ok(store.state().lastWriteError);
    await assert.rejects(store.read("default", id), /软链接/);
  } finally { await rm(data, { recursive: true, force: true }); }
});
