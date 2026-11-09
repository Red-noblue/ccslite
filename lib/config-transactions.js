/**
 * 中文配置事务：基于最新已提交快照生成草稿，持久化确认后才发布。
 * IPC 确认丢失时读取权威状态；无法核对期间暂停配置修改，业务读取继续使用已知快照。
 */
import crypto from "node:crypto";
export function createConfigTransactions({ read, persist, publish, readAuthority }) {
  let queue = Promise.resolve(); let uncertain = false; let lastError = null;
  const reconcile = async () => {
    if (!readAuthority) throw new Error("配置提交结果未确认，暂不能继续修改");
    const authority = await readAuthority();
    if (!authority?.config) throw new Error("无法读取权威配置");
    publish(authority.config); uncertain = false; lastError = null;
    return authority;
  };
  return {
    commit(change) {
      const task = queue.catch(() => {}).then(async () => {
        if (uncertain) await reconcile();
        const previous = read(); const draft = structuredClone(previous);
        const result = await change(draft);
        if (JSON.stringify(previous) === JSON.stringify(draft)) return result;
        const operationId = crypto.randomUUID();
        try { await persist(draft, { operationId }); }
        catch (error) {
          lastError = error.message;
          if (error.code === "handoff_config_conflict") {
            uncertain = true; await reconcile().catch(() => null);
          }
          if (["handoff_ipc_timeout", "handoff_ipc_disconnected"].includes(error.code)) {
            uncertain = true;
            const authority = await reconcile().catch(() => null);
            if (authority?.operationId === operationId) return result;
          }
          throw error;
        }
        publish(draft); lastError = null; return result;
      });
      queue = task; return task;
    },
    async flush() {
      // 已失败且未发布的草稿不阻塞排空；提交结果不明时必须先核对权威状态。
      await queue.catch(() => {});
      if (uncertain) await reconcile();
    },
    state: () => ({ pendingConfirmation: uncertain, lastError }),
  };
}
