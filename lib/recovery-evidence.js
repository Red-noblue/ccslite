/** 恢复证据归档：按组和日期保存低频不可变事件；独立文件支持交接并行写入，默认不删除历史。 */
import crypto from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

const idPattern = /^\d{17}-[a-f0-9-]{36}$/;
const text = (value) => typeof value === "string" ? value.slice(0, 160) : "";
const dayForId = (id) => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
function normalize(event) {
  return { version: 1, eventId: event.eventId, groupId: text(event.groupId),
    kind: ["confirmed", "bindings_migrated", "invalidated"].includes(event.kind) ? event.kind : "invalidated",
    confirmationId: text(event.confirmationId), providerId: text(event.providerId), providerName: text(event.providerName), model: text(event.model),
    timestamp: event.timestamp, source: ["business", "probe", "manual"].includes(event.source) ? event.source : "unknown",
    successCount: Number.isSafeInteger(event.successCount) && event.successCount >= 0 ? event.successCount : 0,
    migratedBindings: Number.isSafeInteger(event.migratedBindings) && event.migratedBindings >= 0 ? event.migratedBindings : 0,
    requestId: text(event.requestId), reason: ["failure_or_configuration", "request_completed", "recovery_confirmed"].includes(event.reason) ? event.reason : "",
  };
}

export function createRecoveryEvidence(dataDir) {
  let queue = Promise.resolve(); let pendingWrites = 0; let lastWriteError = null;
  async function directory(groupId, day, create = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Object.assign(new Error("日期格式必须为 YYYY-MM-DD"), { status: 400 });
    let current = await realpath(dataDir);
    for (const part of ["routing-evidence", crypto.createHash("sha256").update(String(groupId)).digest("hex"), day]) {
      current = path.join(current, part);
      if (create) await mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw new Error("恢复证据目录不允许软链接");
    }
    return current;
  }
  async function read(groupId, eventId) {
    if (!idPattern.test(eventId || "")) return null;
    await queue;
    try {
      const dir = await directory(groupId, dayForId(eventId));
      const file = await open(path.join(dir, `${eventId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat(); if (!info.isFile() || info.size > 16 * 1024) return null;
        const event = JSON.parse(await file.readFile("utf8"));
        return event.version === 1 && event.groupId === groupId && event.eventId === eventId ? normalize(event) : null;
      } finally { await file.close(); }
    } catch (error) { if (["ENOENT", "ELOOP"].includes(error.code) || error instanceof SyntaxError) return null; throw error; }
  }
  return {
    record(input) {
      const timestamp = new Date().toISOString();
      const event = normalize({ ...input, timestamp, eventId: `${timestamp.replace(/\D/g, "")}-${crypto.randomUUID()}` });
      pendingWrites += 1;
      queue = queue.then(async () => {
        const dir = await directory(event.groupId, timestamp.slice(0, 10), true);
        const target = path.join(dir, `${event.eventId}.json`); const temporary = `${target}.tmp`;
        let file;
        try {
          file = await open(temporary, "wx", 0o600); await file.writeFile(JSON.stringify(event) + "\n"); await file.sync(); await file.close(); file = null;
          await rename(temporary, target);
          const folder = await open(dir, "r"); try { await folder.sync(); } finally { await folder.close(); }
          lastWriteError = null;
        } catch (error) { await file?.close(); await unlink(temporary).catch(() => {}); throw error; }
      }).catch(() => { lastWriteError = "恢复证据未保存，请检查数据目录权限和剩余空间；业务路由继续服务"; }).finally(() => { pendingWrites -= 1; });
      return event.eventId;
    },
    read,
    async list(groupId, { day = new Date().toISOString().slice(0, 10), page = 1 } = {}) {
      await queue;
      let dir;
      try { dir = await directory(groupId, day); } catch (error) { if (error.code === "ENOENT") return { day, page: 1, total: 0, events: [] }; throw error; }
      const names = (await readdir(dir)).filter((name) => name.endsWith(".json") && idPattern.test(name.slice(0, -5))).sort().reverse();
      const total = names.length; page = Math.max(1, Math.min(Math.ceil(total / 30) || 1, Math.floor(Number(page) || 1)));
      const events = [];
      for (const name of names.slice((page - 1) * 30, page * 30)) { const event = await read(groupId, name.slice(0, -5)); if (event) events.push(event); }
      return { day, page, pageSize: 30, total, events };
    },
    flush: () => queue,
    state: () => ({ pendingWrites, lastWriteError }),
  };
}
