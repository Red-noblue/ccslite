/** 中文配置事务测试：提交失败不发布草稿，并发修改合并最新状态，丢确认后核对权威结果。 */
import assert from "node:assert/strict";
import test from "node:test";
import { createConfigTransactions } from "../../lib/config-transactions.js";
test("写入失败保留旧内存，后续并发事务不丢字段", async () => {
  let config = { a: 0, b: 0 }; let fail = true;
  const store = createConfigTransactions({ read: () => config, publish: (value) => { config = value; }, persist: async () => { if (fail) throw new Error("磁盘失败"); } });
  await assert.rejects(store.commit((draft) => { draft.a = 99; }), /磁盘失败/);
  assert.deepEqual(config, { a: 0, b: 0 }); fail = false;
  await Promise.all([store.commit((draft) => { draft.a = 1; }), store.commit((draft) => { draft.b = 2; })]);
  assert.deepEqual(config, { a: 1, b: 2 });
});
test("丢失确认时读取已提交结果，无法核对则阻止后续配置修改", async () => {
  let config = { a: 0 }; let authority; let unavailable = false; let writes = 0;
  const store = createConfigTransactions({ read: () => config, publish: (value) => { config = value; },
    persist: async (draft, { operationId }) => { writes++; authority = { config: draft, operationId }; throw Object.assign(new Error("确认丢失"), { code: "handoff_ipc_timeout" }); },
    readAuthority: async () => { if (unavailable) throw new Error("无法核对"); return authority; } });
  await store.commit((draft) => { draft.a = 1; }); assert.equal(config.a, 1); assert.equal(writes, 1);
  unavailable = true;
  await assert.rejects(store.commit((draft) => { draft.a = 2; }));
  assert.equal(config.a, 1); assert.equal(store.state().pendingConfirmation, true);
  await assert.rejects(store.commit((draft) => { draft.a = 3; }), /无法核对/); assert.equal(writes, 2);
  unavailable = false; await store.commit(() => {}); assert.equal(config.a, 2);
});
