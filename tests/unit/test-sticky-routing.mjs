/**
 * 缓存友好型粘滞路由测试。
 * 验证会话标识提取、供应商保持、失败清除、响应 ID 别名和过期行为。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createStickyRoutingStore,
  extractResponseIds,
  extractRoutingContext,
  shouldInvalidateSticky,
} from "../../lib/sticky-routing.js";

const providers = [
  { id: "first", name: "第一个" },
  { id: "second", name: "第二个" },
  { id: "third", name: "第三个" },
];

test("优先使用显式会话头，并按模型隔离粘滞键", () => {
  const context = extractRoutingContext(
    { headers: { "x-codex-session-id": "session-a" } },
    Buffer.from(JSON.stringify({ model: "gpt-5.6-terra" })),
    "gpt-5.6-terra",
  );
  assert.equal(context.eligible, true);
  assert.equal(context.source, "header:x-codex-session-id");
  assert.match(context.key, /^cct:gpt-5\.6-terra:/);

  const otherModel = extractRoutingContext(
    { headers: { "x-codex-session-id": "session-a" } },
    Buffer.from(JSON.stringify({ model: "gpt-6-astra" })),
    "gpt-6-astra",
  );
  assert.notEqual(context.key, otherModel.key);

  const bodyContext = extractRoutingContext(
    { headers: {} },
    Buffer.from(JSON.stringify({ model: "gpt-5.6-terra", conversation_id: "session-a" })),
    "gpt-5.6-terra",
  );
  assert.equal(context.key, bodyContext.key);
});

test("会话头和 previous_response_id 同时存在时，两类路由上下文都保留", () => {
  const context = extractRoutingContext(
    { headers: { "x-codex-session-id": "session-a" } },
    Buffer.from(JSON.stringify({ model: "gpt-5.6-terra", previous_response_id: "resp_123" })),
    "gpt-5.6-terra",
  );
  assert.equal(context.source, "header:x-codex-session-id");
  assert.equal(context.previousResponseId, "resp_123");
});

test("没有会话头时使用客户端身份摘要，不保存原始凭据", () => {
  const context = extractRoutingContext(
    {
      headers: {
        "user-agent": "codex-test",
        authorization: "Bearer secret-value",
      },
    },
    Buffer.from(JSON.stringify({ model: "gpt-5.6-terra" })),
    "gpt-5.6-terra",
  );
  assert.equal(context.source, "client_identity");
  assert.equal(context.value, "");
  assert.equal(context.key.includes("secret-value"), false);
});

test("成功后保持供应商，失败后允许按优先级回退", () => {
  const store = createStickyRoutingStore({ now: () => 1000, ttlMs: 10000 });
  store.rememberSuccess("session-key", "second");
  assert.deepEqual(
    store.orderProviders("session-key", providers).map((provider) => provider.id),
    ["second", "first", "third"],
  );
  assert.equal(store.markFailure("session-key", "second"), true);
  assert.deepEqual(
    store.orderProviders("session-key", providers).map((provider) => provider.id),
    ["first", "second", "third"],
  );
});

test("响应 ID 可以把后续 previous_response_id 关联回原会话", () => {
  let now = 1000;
  const store = createStickyRoutingStore({ now: () => now, ttlMs: 10000 });
  store.rememberSuccess("cct:gpt-5.6-terra:session-key", "second", ["resp_123"], "gpt-5.6-terra");
  assert.equal(store.resolvePreviousResponse("resp_123", "gpt-5.6-terra"), "cct:gpt-5.6-terra:session-key");
  assert.equal(store.resolvePreviousResponse("resp_123", "gpt-6-astra"), "");
  now = 12000;
  assert.equal(store.resolvePreviousResponse("resp_123", "gpt-5.6-terra"), "");
});

test("低价供应商确认恢复后只迁移同模型的较贵粘滞", () => {
  const store = createStickyRoutingStore({ now: () => 1000, ttlMs: 10000 });
  const terraKey = "cct:gpt-5.6-terra:terra-session";
  const astraKey = "cct:gpt-6-astra:astra-session";
  store.rememberSuccess(terraKey, "second", ["resp_old"], "gpt-5.6-terra");
  store.rememberSuccess(astraKey, "third", [], "gpt-6-astra");

  const migrated = store.migrateToProvider("first", {
    model: "gpt-5.6-terra",
    shouldReplace: (providerId) => providerId === "second",
  });

  assert.equal(migrated, 1);
  assert.equal(store.get(terraKey).providerId, "first");
  assert.equal(store.get(astraKey).providerId, "third");
  assert.deepEqual(
    store.orderProviders(terraKey, providers).map((provider) => provider.id),
    ["first", "second", "third"],
  );
  assert.deepEqual(store.resolvePreviousResponseContext("resp_old", "gpt-5.6-terra"), {
    key: terraKey,
    providerId: "first",
    fallbackProviderIds: ["second"],
  });
});

test("可从普通响应和 SSE response.created 事件提取响应 ID", () => {
  assert.deepEqual(
    extractResponseIds(
      Buffer.from(JSON.stringify({ id: "resp_buffer" })),
      null,
    ),
    ["resp_buffer"],
  );
  assert.deepEqual(
    extractResponseIds(
      null,
      'data: {"type":"response.created","response":{"id":"resp_stream"}}\n\n',
    ),
    ["resp_stream"],
  );
});

test("显式固定路由不创建粘滞上下文", () => {
  const context = extractRoutingContext(
    { headers: { "x-codex-session-id": "session-a" } },
    Buffer.from(JSON.stringify({ model: "gpt-5.6-terra" })),
    "gpt-5.6-terra",
    "plus",
  );
  assert.equal(context.eligible, false);
  assert.equal(context.key, "");
});

test("客户端主动断开不清除粘滞，供应商错误会清除粘滞", () => {
  assert.equal(
    shouldInvalidateSticky({ retryable: true, failureClass: "client_connection_closed" }),
    false,
  );
  assert.equal(
    shouldInvalidateSticky({ retryable: true, failureClass: "upstream_5xx" }),
    true,
  );
});
