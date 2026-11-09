/**
 * 版本监督器所有权登记：保存 PID 与进程启动时间，拒绝误认复用的 PID。
 * 仅在原监督器及所有登记子进程都已结束后归档旧锁；恢复操作串行执行。
 */
import { spawnSync } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("进程登记包含无效 PID");
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error || ![0, 1].includes(result.status)) throw new Error("无法确认原进程身份，停止恢复操作");
  const startedAt = result.stdout.trim();
  return startedAt ? { pid, startedAt } : null;
}

function stillRunning(identity) {
  if (!identity?.startedAt) throw new Error("旧锁缺少进程身份，不能自动恢复");
  const current = processIdentity(identity.pid);
  return current?.startedAt === identity.startedAt;
}

export async function acquireReleaseLock(dataRoot) {
  const lockPath = path.join(dataRoot, "release-runner.lock");
  const owner = processIdentity(process.pid);
  const state = { format: 1, owner, children: [] };
  const fresh = () => open(lockPath, "wx", 0o600);
  let handle;
  try { handle = await fresh(); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const guardPath = path.join(dataRoot, "release-recovery.lock");
    const guard = await open(guardPath, "wx", 0o600).catch(() => { throw new Error("另一个版本恢复操作进行中，保留已有服务"); });
    try {
      await guard.writeFile(JSON.stringify(owner));
      let previous;
      try {
        const info = await lstat(lockPath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("旧锁必须是普通文件");
        previous = JSON.parse(await readFile(lockPath, "utf8"));
      }
      catch (readError) {
        if (readError.code !== "ENOENT") throw new Error("旧锁格式不完整，不能自动恢复，请先核实原进程状态");
      }
      if (previous) {
        if (previous.format !== 1 || !Array.isArray(previous.children)) throw new Error("旧锁缺少进程身份，不能自动恢复");
        if (stillRunning(previous.owner)) throw new Error("该数据目录已有版本监督器，保持现有服务不动");
        if (previous.children.some(stillRunning)) throw new Error("原监督器已退出，但其子进程仍在排空或运行，暂不接管数据目录");
        const recoveryDir = path.join(dataRoot, "release-recovery");
        await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
        await rename(lockPath, path.join(recoveryDir, `abandoned-lock-${crypto.randomUUID()}.json`));
      }
      handle = await fresh();
    } finally {
      await guard.close();
      await unlink(guardPath);
    }
  }
  const info = await handle.stat();
  const save = async () => {
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
    const result = await handle.write(bytes, 0, bytes.length, 0);
    if (result.bytesWritten !== bytes.length) throw new Error("监督器身份未完整写入，停止启动");
    await handle.truncate(bytes.length);
    await handle.sync();
  };
  try { await save(); }
  catch (error) { await handle.close(); await unlink(lockPath); throw error; }
  return {
    async track(pid) {
      const identity = processIdentity(pid);
      if (identity) { state.children.push(identity); await save(); }
    },
    async release() {
      await handle.close();
      // 只移除本次创建的锁，绝不清除后来启动器的文件。
      const current = await lstat(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
      if (current?.ino === info.ino && current.dev === info.dev) await unlink(lockPath);
    },
  };
}
