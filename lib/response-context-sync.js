/** 中文响应上下文增量同步：保留未确认更新，确认成功后才允许交接越过同步屏障。 */
export function createResponseContextSync({ send, retryConflict = () => null, acceptContext = () => {} } = {}) {
  const pending = new Map();
  let queue = Promise.resolve();
  let lastError = null;
  const key = (item) => JSON.stringify([item.scope, item.model, item.responseId]);
  return {
    enqueue(change) {
      const id = key(change); const previous = pending.get(id);
      pending.set(id, previous ? { ...change, expectedProviderId: previous.expectedProviderId,
        expectedFallbackProviderIds: previous.expectedFallbackProviderIds } : change);
    },
    flush() {
      const task = queue.catch(() => {}).then(async () => {
        while (pending.size) {
          const batch = [...pending.entries()].slice(0, 256);
          const results = await send(batch.map(([, change]) => change));
          if (!Array.isArray(results) || results.length !== batch.length) throw new Error("前置器未完整确认响应上下文变更");
          if (results.some((result) => !result || !["updated", "missing", "rejected", "conflict"].some((field) => result[field] === true))) throw new Error("前置器返回了无效的响应上下文确认");
          for (let i = 0; i < batch.length; i += 1) {
            const [id, change] = batch[i]; const result = results[i];
            if (pending.get(id) !== change) continue;
            if (result.conflict && !change.retried) {
              const retried = retryConflict(change, result.context);
              if (retried) { pending.set(id, { ...retried, retried: true }); continue; }
            }
            if (result.updated || result.context) acceptContext(change, result.updated ? change : result.context);
            pending.delete(id);
          }
        }
        lastError = null;
      }).catch((error) => { lastError = error.message; throw error; });
      queue = task; return task;
    },
    state: () => ({ pending: pending.size, lastError }),
  };
}
