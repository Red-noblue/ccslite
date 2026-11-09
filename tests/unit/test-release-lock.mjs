/**
 * 监督器锁测试：验证存活进程保护、退出后的归档恢复、PID 复用和不完整锁的处理。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireReleaseLock } from "../../lib/release-lock.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "lite-release-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "release-runner.lock") };
}

test("已有监督器存活时拒绝接管，并保留原锁", async (t) => {
  const f = await fixture(t);
  const lock = await acquireReleaseLock(f.root);
  t.after(() => lock.release());
  const before = await readFile(f.file, "utf8");
  await assert.rejects(acquireReleaseLock(f.root), /已有版本监督器/);
  assert.equal(await readFile(f.file, "utf8"), before);
});

test("监督器已退出但登记的子进程仍活着时拒绝接管", async (t) => {
  const f = await fixture(t);
  const lock = await acquireReleaseLock(f.root);
  const state = JSON.parse(await readFile(f.file, "utf8"));
  await lock.release();
  await writeFile(f.file, JSON.stringify({ format: 1, owner: { pid: process.pid, startedAt: "历史进程" }, children: [state.owner] }));
  await assert.rejects(acquireReleaseLock(f.root), /子进程仍在排空或运行/);
});

test("PID 已被其他进程复用时仅归档旧锁，不操作新的进程", async (t) => {
  const f = await fixture(t);
  const previous = { format: 1, owner: { pid: process.pid, startedAt: "已退出的旧进程" }, children: [] };
  await writeFile(f.file, JSON.stringify(previous));
  const lock = await acquireReleaseLock(f.root);
  await lock.track(process.pid);
  const current = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(current.owner.pid, process.pid);
  assert.equal(current.children[0].pid, process.pid);
  assert.notEqual(current.owner.startedAt, previous.owner.startedAt);
  const files = await readdir(path.join(f.root, "release-recovery"));
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, "release-recovery", files[0]), "utf8")), previous);
  await lock.release();
});

test("旧版纯 PID 或损坏的锁不自动删除或接管", async (t) => {
  const f = await fixture(t);
  for (const raw of [String(process.pid), "{broken"]) {
    await writeFile(f.file, raw);
    await assert.rejects(acquireReleaseLock(f.root), /不能自动恢复/);
    assert.equal(await readFile(f.file, "utf8"), raw);
  }
});
