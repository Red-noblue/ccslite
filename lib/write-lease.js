/**
 * 中文数据写入租约：用独立目录和原子创建保证同一数据目录只有一个可写版本。
 * 仅在原进程确实退出后归档旧租约；过期不构成抢占存活进程的依据。
 */
import crypto from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const FORMAT = 1;
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

async function readOwner(directory) {
  const invalid = (cause) => Object.assign(new Error("数据写入租约不完整，保留现场并停止接管", { cause }), { code: "WRITE_LEASE_INVALID", status: 409 });
  let owner;
  try { owner = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")); }
  catch (error) { throw invalid(error); }
  if (owner?.format !== FORMAT || typeof owner.instanceId !== "string" || !owner.instanceId ||
      typeof owner.epoch !== "string" || !owner.epoch || !Number.isInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.expiresAt)) throw invalid();
  return owner;
}

export function createWriteLease({ directory, instanceId = crypto.randomUUID(), pid = process.pid,
  ttlMs = 30_000, now = () => Date.now(), archiveDirectory = path.join(path.dirname(directory), "release-recovery") } = {}) {
  if (!directory) throw new TypeError("租约目录不能为空");
  let owner = null;
  const valid = (value) => value?.format === FORMAT && value.instanceId && value.pid === pid &&
    Number.isFinite(value.expiresAt) && value.expiresAt > now();
  const mine = (value) => owner && value?.format === FORMAT && value.instanceId === instanceId && value.pid === pid && value.epoch === owner.epoch;
  const busy = (existing) => Object.assign(new Error(`数据写入租约已被 ${existing.instanceId}（PID ${existing.pid}）持有`), { code: "WRITE_LEASE_BUSY", status: 409, owner: existing });
  const assertMine = async () => {
    const existing = await readOwner(directory);
    if (!mine(existing)) throw Object.assign(new Error("写入租约已被其他实例接管"), { code: "WRITE_LEASE_LOST", status: 409 });
  };
  const writeOwner = async (value) => {
    const temporary = path.join(directory, `.owner-${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(directory, "owner.json"));
  };
  const archiveStale = async () => {
    await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(archiveDirectory, `write-lease-${Date.now()}-${crypto.randomUUID()}`);
    await rename(directory, target);
  };
  const createOwner = async () => {
    const next = { format: FORMAT, instanceId, pid, epoch: crypto.randomUUID(), acquiredAt: new Date(now()).toISOString(), expiresAt: now() + ttlMs };
    await writeOwner(next); owner = next; return { ...owner };
  };
  return {
    instanceId,
    async acquire() {
      if (owner) {
        await assertMine();
        // 同一持有者在暂停后可重新取得有效期；磁盘 epoch 必须仍然属于自己。
        const next = { ...owner, expiresAt: now() + ttlMs };
        await writeOwner(next); owner = next; return { ...owner };
      }
      try { await mkdir(directory, { recursive: false, mode: 0o700 }); return createOwner(); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const guardPath = `${directory}.recovery.lock`;
        const guard = await open(guardPath, "wx", 0o600).catch((guardError) => {
          if (guardError.code !== "EEXIST") throw guardError;
          throw Object.assign(new Error("另一个写入租约回收操作正在进行"), { code: "WRITE_LEASE_BUSY", status: 409 });
        });
        try {
          // 在回收锁内重新读取，不能使用争用前读到的旧 owner。
          const existing = await readOwner(directory);
          if (alive(existing.pid)) throw busy(existing);
          await archiveStale();
          try { await mkdir(directory, { mode: 0o700 }); }
          catch (createError) { if (createError.code !== "EEXIST") throw createError; throw busy(await readOwner(directory)); }
          return await createOwner();
        } finally {
          await guard.close(); await unlink(guardPath);
        }
      }
    },
    async renew() {
      if (!valid(owner)) throw Object.assign(new Error("当前写入租约已失效"), { code: "WRITE_LEASE_EXPIRED", status: 409 });
      await assertMine();
      const next = { ...owner, expiresAt: now() + ttlMs };
      await writeOwner(next); owner = next; return { ...owner };
    },
    async release() {
      if (!owner) return false;
      await assertMine();
      await rm(directory, { recursive: true, force: false }); owner = null; return true;
    },
    isHeld() { return valid(owner); },
    getOwner() { return owner ? { ...owner } : null; },
  };
}
