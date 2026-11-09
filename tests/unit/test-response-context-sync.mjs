/** 中文响应上下文同步测试：确认屏障、失败重试及冲突次数有界。 */
import assert from "node:assert/strict";
import test from "node:test";
import { createResponseContextSync } from "../../lib/response-context-sync.js";
import { createStickyRoutingStore } from "../../lib/sticky-routing.js";
const change = { scope: "a", model: "m", responseId: "r", expectedProviderId: "b", providerId: "a", fallbackProviderIds: ["b"] };
test("确认前保留待同步记录，失败后相同变更可以继续提交", async () => {
  let reject = true; let release;
  const sync = createResponseContextSync({ send: async () => {
    if (reject) throw new Error("确认丢失");
    await new Promise((resolve) => { release = resolve; }); return [{ updated: true }];
  } });
  sync.enqueue(change);
  await assert.rejects(sync.flush(), /确认丢失/); assert.equal(sync.state().pending, 1);
  reject = false; const barrier = sync.flush();
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(sync.state().pending, 1);
  release(); await barrier; assert.equal(sync.state().pending, 0);
});
test("冲突只重新判定一次，退役来源不会无限重试", async () => {
  let calls = 0;
  const sync = createResponseContextSync({ send: async () => { calls += 1; return [{ conflict: true, context: { providerId: "new", fallbackProviderIds: [] } }]; },
    retryConflict: (item, context) => ({ ...item, expectedProviderId: context.providerId }) });
  sync.enqueue(change); await sync.flush(); assert.equal(calls, 2); assert.equal(sync.state().pending, 0);
});

test("冲突以权威上下文对齐本地别名，同时保护并发写入的新供应商", async () => {
  const sticky = createStickyRoutingStore();
  sticky.rememberSuccess("s", "b", ["r"], "m");
  let migrated;
  sticky.migrateToProvider("a", { model: "m", onAliasMigrated: (item) => { migrated = item; } });
  const sync = createResponseContextSync({ send: async () => [{ conflict: true, context: { providerId: "c", fallbackProviderIds: ["b"] } }],
    acceptContext: (item, context) => sticky.acceptResponseContext(item.responseId, item.model, item.providerId, context) });
  sync.enqueue(migrated); await sync.flush();
  assert.equal(sticky.resolvePreviousResponseContext("r", "m").providerId, "c");
  sticky.rememberSuccess("s", "new", ["r"], "m");
  sync.enqueue(migrated); await sync.flush();
  assert.equal(sticky.resolvePreviousResponseContext("r", "m").providerId, "new");
});
