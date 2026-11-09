/**
 * 中文写入租约测试：验证独占、过期归档、续租、释放和失效，不接触正式数据目录。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWriteLease } from "../../lib/write-lease.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-write-lease-"));
  return { root, directory: path.join(root, "lease"), archive: path.join(root, "recovery") };
}

test("同一数据目录只允许一个活跃实例持有租约", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = createWriteLease({ directory: f.directory, archiveDirectory: f.archive, instanceId: "first", pid: process.pid });
  await first.acquire();
  const second = createWriteLease({ directory: f.directory, archiveDirectory: f.archive, instanceId: "second", pid: process.pid });
  await assert.rejects(second.acquire(), (error) => error.code === "WRITE_LEASE_BUSY" && error.owner.instanceId === "first");
  assert.equal(first.isHeld(), true); await first.release(); assert.equal(first.isHeld(), false);
  await second.acquire(); await second.release();
});

test("过期租约会归档后再接管，不删除审计文件", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); let clock = 1_000;
  const stale = createWriteLease({ directory: f.directory, archiveDirectory: f.archive, instanceId: "stale", pid: 999_999, ttlMs: 10, now: () => clock });
  await stale.acquire(); clock += 20;
  const next = createWriteLease({ directory: f.directory, archiveDirectory: f.archive, instanceId: "next", pid: process.pid, now: () => clock });
  await next.acquire(); const files = await readdir(f.archive); assert.equal(files.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(f.archive, files[0], "owner.json"), "utf8")).instanceId, "stale"); await next.release();
});

test("续租延长有效期，释放只允许当前实例执行", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); let clock = 10_000;
  const lease = createWriteLease({ directory: f.directory, archiveDirectory: f.archive, instanceId: "owner", pid: process.pid, ttlMs: 10, now: () => clock });
  const first = await lease.acquire(); clock += 5; const renewed = await lease.renew();
  assert.equal(renewed.epoch, first.epoch); assert.ok(renewed.expiresAt > first.expiresAt); assert.equal(lease.isHeld(), true);
  clock += 20; assert.equal(lease.isHeld(), false); await assert.rejects(lease.renew(), /租约已失效/);
  const next = createWriteLease({ directory: f.directory, archiveDirectory: f.archive, instanceId: "next", pid: process.pid, now: () => clock });
  await assert.rejects(next.acquire(), (error) => error.code === "WRITE_LEASE_BUSY");
  await lease.release(); await next.acquire(); await next.release();
});

test("时钟超过有效期也不能抢走存活进程的租约", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); let clock = 100;
  const first = createWriteLease({ directory: f.directory, ttlMs: 10, now: () => clock });
  const original = await first.acquire(); clock += 100;
  const second = createWriteLease({ directory: f.directory, now: () => clock });
  await assert.rejects(second.acquire(), (error) => error.code === "WRITE_LEASE_BUSY");
  assert.equal(JSON.parse(await readFile(path.join(f.directory, "owner.json"), "utf8")).epoch, original.epoch);
  await first.release();
});

test("租约被改成其他 epoch 后，旧实例不能续租或释放", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = createWriteLease({ directory: f.directory }); const original = await first.acquire();
  const replacement = { ...original, epoch: "replacement-epoch" };
  await writeFile(path.join(f.directory, "owner.json"), JSON.stringify(replacement));
  await assert.rejects(first.renew(), (error) => error.code === "WRITE_LEASE_LOST");
  await assert.rejects(first.release(), (error) => error.code === "WRITE_LEASE_LOST");
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, "owner.json"), "utf8")), replacement);
});

test("不完整的租约不能当成过期租约覆盖", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(f.directory);
  const lease = createWriteLease({ directory: f.directory });
  await assert.rejects(lease.acquire(), (error) => error.code === "WRITE_LEASE_INVALID");
  await writeFile(path.join(f.directory, "owner.json"), "{broken");
  await assert.rejects(lease.acquire(), (error) => error.code === "WRITE_LEASE_INVALID");
  assert.equal(await readFile(path.join(f.directory, "owner.json"), "utf8"), "{broken");
});

test("多个实例并发接管已退出进程时只能有一个成功", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const stale = createWriteLease({ directory: f.directory, archiveDirectory: f.archive, pid: 999_999 });
  await stale.acquire();
  const candidates = Array.from({ length: 6 }, (_, index) => createWriteLease({ directory: f.directory, archiveDirectory: f.archive, instanceId: `candidate-${index}` }));
  const attempts = await Promise.allSettled(candidates.map((lease) => lease.acquire()));
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const winner = attempts.findIndex((result) => result.status === "fulfilled");
  assert.equal(JSON.parse(await readFile(path.join(f.directory, "owner.json"), "utf8")).instanceId, `candidate-${winner}`);
  await candidates[winner].release();
});
