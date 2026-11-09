/**
 * 中文前置器持久化通道：由监督器串行写入用量、诊断和配置，避免新旧工作进程并发覆盖共享数据。
 * 用量使用请求记录 ID 去重；配置写入只接受当前活动工作进程，旧交接进程不能覆盖新配置。
 */
import { mkdir, open, readdir, rename, lstat } from "node:fs/promises";
import path from "node:path";
import { appendUsageRecord, loadUsageRecords } from "./usage-store.js";
import { createConfigStore } from "./config-store.js";

export function createHandoffPersistence({ dataDir, usagePath = path.join(dataDir, "usage.jsonl"), configPath = path.join(dataDir, "config.json"), diagnosticPath = path.join(dataDir, "413-diagnostics.jsonl"), maxRecentIds = 20_000, onEvent = () => {} } = {}) {
  if (!dataDir) throw new TypeError("持久化通道需要数据目录");
  const configStore = createConfigStore(configPath);
  const committed = new Set();
  const pending = new Map();
  let usageQueue = Promise.resolve();
  let configQueue = Promise.resolve();
  let activeWorkerId = null;
  let configRevision = 0;
  let configOperationId = null;
  let diagnosticQueue = Promise.resolve();
  const pendingUsageDirectory = path.join(dataDir, "handoff-pending-usage");
  const recoveredUsageDirectory = path.join(dataDir, "release-recovery", "handoff-pending-usage");

  const remember = (id) => {
    if (!id) return;
    committed.add(id);
    while (committed.size > Math.max(100, Number(maxRecentIds) || 20_000)) committed.delete(committed.values().next().value);
  };
  const appendDiagnostic = async (record) => {
    await mkdir(path.dirname(diagnosticPath), { recursive: true, mode: 0o700 });
    const file = await open(diagnosticPath, "a", 0o600);
    try { await file.writeFile(`${JSON.stringify(record)}\n`); await file.sync(); }
    finally { await file.close(); }
  };

  return {
    setActiveWorker(workerId) { activeWorkerId = workerId || null; },
    async pauseConfigWrites() {
      // 先关闭旧提交入口，再等待已受理的配置真正落盘；不能把保存失败当作交接成功。
      activeWorkerId = "__transferring__";
      await configQueue;
    },
    activeWorker: () => activeWorkerId,
    revision: () => configRevision,
    appendUsage(record, { workerId = null, dedupeKey = record?.id } = {}) {
      const key = String(dedupeKey || record?.id || "");
      if (!key) return Promise.reject(new Error("用量记录缺少幂等 ID"));
      if (committed.has(key)) return Promise.resolve({ deduplicated: true, key });
      // 在途重复提交共享实际落盘结果，不能把尚未完成或失败的写入当成成功。
      if (pending.has(key)) return pending.get(key).then(() => ({ deduplicated: true, key }));
      const task = usageQueue.catch(() => {}).then(async () => {
        if (committed.has(key)) return { deduplicated: true, key };
        await appendUsageRecord(usagePath, { ...record, handoffWorkerId: workerId || null });
        remember(key);
        onEvent({ event: "handoff_usage_committed", key, workerId: workerId || null });
        return { deduplicated: false, key };
      });
      pending.set(key, task);
      usageQueue = task.catch(() => {});
      const cleanup = () => { if (pending.get(key) === task) pending.delete(key); };
      task.then(cleanup, cleanup);
      return task;
    },
    saveConfig(config, { workerId = null, baseRevision = null, operationId = null } = {}) {
      if (activeWorkerId && workerId && String(workerId) !== String(activeWorkerId)) {
        return Promise.reject(Object.assign(new Error("旧交接进程不能覆盖当前版本配置"), { code: "handoff_stale_worker", status: 409 }));
      }
      const snapshot = structuredClone(config);
      const task = configQueue.catch(() => {}).then(async () => {
        if (activeWorkerId && workerId && activeWorkerId !== "__transferring__" && String(workerId) !== String(activeWorkerId)) {
          throw Object.assign(new Error("旧交接进程不能覆盖当前版本配置"), { code: "handoff_stale_worker", status: 409 });
        }
        if (baseRevision !== null && Number(baseRevision) !== configRevision) {
          throw Object.assign(new Error("配置版本已经变化，请重新读取后再保存"), { code: "handoff_config_conflict", status: 409 });
        }
        await configStore.save(snapshot);
        configRevision += 1;
        configOperationId = operationId;
        onEvent({ event: "handoff_config_committed", workerId: workerId || null, revision: configRevision });
        return { revision: configRevision };
      });
      configQueue = task;
      return task;
    },
    async readConfig() {
      await configQueue.catch(() => {});
      return { config: await configStore.load(), revision: configRevision, operationId: configOperationId };
    },
    appendDiagnostic(record, { workerId = null } = {}) {
      const task = diagnosticQueue.catch(() => {}).then(() => appendDiagnostic({ ...record, handoffWorkerId: workerId || null }));
      diagnosticQueue = task.catch(() => {});
      return task;
    },
    async recoverPendingUsage() {
      // 先登记现有主日志的 ID，避免监督器重启时重复合并同一条记录。
      const existing = await loadUsageRecords(usagePath, () => {});
      for (const record of existing.records) remember(record.id);
      const names = await readdir(pendingUsageDirectory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      let recovered = 0;
      await mkdir(recoveredUsageDirectory, { recursive: true, mode: 0o700 });
      for (const name of names.filter((value) => value.endsWith(".jsonl"))) {
        const source = path.join(pendingUsageDirectory, name);
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`用量暂存文件不是普通文件：${name}`);
        const loaded = await loadUsageRecords(source, () => {});
        for (const record of loaded.records) {
          const key = String(record.id || "");
          if (!key) continue;
          const result = await this.appendUsage(record, { workerId: record.handoffWorkerId || "recovered", dedupeKey: key });
          if (!result.deduplicated) recovered += 1;
        }
        await this.flush();
        await rename(source, path.join(recoveredUsageDirectory, `${Date.now()}-${name}`));
      }
      if (recovered) onEvent({ event: "handoff_pending_usage_recovered", count: recovered });
      return recovered;
    },
    async flush() { await usageQueue; await configQueue.catch(() => {}); await diagnosticQueue; },
    state() { return { activeWorkerId, configRevision, committedUsageIds: committed.size, pendingUsageWrites: pending.size }; },
  };
}

