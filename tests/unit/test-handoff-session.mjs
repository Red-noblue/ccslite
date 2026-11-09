/**
 * 中文会话交接基础测试：验证脱敏会话键、响应别名和请求完成后的边界迁移。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createHandoffSessionRegistry,
  decodeHandoffResponseContext,
  encodeHandoffResponseContext,
  extractPreviousResponseId,
  extractSessionKey,
  responseContextScope,
} from "../../lib/handoff-session.js";

test("会话键只保存摘要，且能从请求头或请求体稳定提取", () => {
  const first = extractSessionKey({ "x-codex-session-id": "session-a", authorization: "Bearer secret" }, { model: "fake" }, "fake");
  const second = extractSessionKey({ "x-codex-session-id": "session-a" }, { model: "fake" }, "fake");
  assert.equal(first.key, second.key);
  assert.equal(first.key.includes("session-a"), false);
  assert.equal(extractSessionKey({}, { conversation_id: "body-a" }, "fake").eligible, true);
  assert.equal(extractPreviousResponseId({ previous_response_id: "resp-1" }), "resp-1");
});

test("新会话进入候选版本，旧会话请求完成后才迁移", () => {
  let now = 1000;
  const registry = createHandoffSessionRegistry({ now: () => now });
  const old = { id: "old", pid: 1 }; const next = { id: "next", pid: 2 };
  registry.registerWorker(old, "active");
  const sessionKey = "cct:fake:old-session";
  assert.equal(registry.beginRequest({ sessionKey }), old);
  registry.beginHandoff(old, next);
  assert.equal(registry.owner({ sessionKey }), old);
  assert.equal(registry.owner({ sessionKey: "cct:fake:new-session" }), next);
  assert.equal(registry.finishRequest({ sessionKey, worker: old, completed: true }), true);
  assert.equal(registry.owner({ sessionKey }), next);
  now += 10;
  registry.checkpoint({ sessionKey, responseIds: ["resp-1"], worker: next, completed: true });
  assert.equal(registry.owner({ previousResponseId: "resp-1" }), next);
});

test("响应别名在版本交接检查点中保留供应商与有序回退上下文", () => {
  const registry = createHandoffSessionRegistry();
  const worker = { id: "active", pid: 1 };
  registry.registerWorker(worker, "active");
  registry.checkpoint({
    sessionKey: "cct:fake:session",
    responseIds: ["resp-context"],
    worker,
    providerId: "provider-a",
    fallbackProviderIds: ["provider-b", "provider-a", "provider-c"],
    model: "fake-model",
  });

  assert.deepEqual(registry.resolveResponseContext("resp-context", "fake-model"), {
    providerId: "provider-a",
    fallbackProviderIds: ["provider-b", "provider-c"],
  });
  assert.equal(registry.resolveResponseContext("resp-context", "other-model"), null);
});

test("内部响应上下文头只接受有限、去重后的供应商标识", () => {
  const encoded = encodeHandoffResponseContext("provider-a", ["provider-b", "provider-a", "provider-b"]);
  assert.deepEqual(decodeHandoffResponseContext(encoded), {
    providerId: "provider-a",
    fallbackProviderIds: ["provider-b"],
  });
  assert.equal(decodeHandoffResponseContext("not-base64-json"), null);
  assert.equal(decodeHandoffResponseContext("a".repeat(9000)), null);
  assert.equal(encodeHandoffResponseContext("", []), "");
});

test("同一会话并发请求保持旧版本，完成前不会迁移", () => {
  const registry = createHandoffSessionRegistry();
  const old = { id: "old", pid: 1 }; const next = { id: "next", pid: 2 };
  registry.registerWorker(old, "active");
  const sessionKey = "cct:fake:concurrent";
  registry.beginRequest({ sessionKey }); registry.beginHandoff(old, next);
  assert.equal(registry.beginRequest({ sessionKey }), old);
  assert.equal(registry.finishRequest({ sessionKey, worker: old, completed: true }), false);
  assert.equal(registry.owner({ sessionKey }), old);
  assert.equal(registry.finishRequest({ sessionKey, worker: old, completed: true }), true);
  assert.equal(registry.owner({ sessionKey }), next);
});

test("候选版本崩溃时，失败版本的会话立即回到旧版本", () => {
  const registry = createHandoffSessionRegistry();
  const old = { id: "old", pid: 1 }; const next = { id: "next", pid: 2 };
  registry.registerWorker(old, "active");
  const sessionKey = "cct:fake:crashed";
  registry.beginRequest({ sessionKey }); registry.beginHandoff(old, next);
  registry.rollback(next, old);
  assert.equal(registry.owner({ sessionKey }), old);
  assert.equal(registry.state().pendingMigrations, 0);
});


test("响应上下文和交接计数按分组路由隔离，旧进程不能覆盖已迁移会话", () => {
  const registry = createHandoffSessionRegistry();
  const old = { id: "old", pid: 1 }; const next = { id: "next", pid: 2 };
  registry.registerWorker(old, "active");
  for (const [sessionKey, scope, providerId] of [["group-a-session", "group-a", "a"], ["group-b-session", "group-b", "b"]]) {
    registry.beginRequest({ sessionKey, scope });
    registry.checkpoint({ sessionKey, responseIds: ["same-id"], worker: old, providerId, model: "m" });
  }
  assert.equal(registry.resolveResponseContext("same-id", "m", "group-a").providerId, "a");
  assert.equal(registry.resolveResponseContext("same-id", "m", "group-b").providerId, "b");
  const change = { responseId: "same-id", scope: "group-a", model: "m", expectedProviderId: "a", providerId: "preferred", fallbackProviderIds: ["a"] };
  assert.equal(registry.updateResponseContexts(old, [change])[0].updated, true);
  assert.equal(registry.updateResponseContexts(old, [{ ...change, providerId: "wrong" }])[0].conflict, true);
  registry.beginHandoff(old, next);
  registry.finishRequest({ sessionKey: "group-a-session", worker: old, completed: true });
  assert.equal(registry.owner({ sessionKey: "group-a-session" }), next);
  assert.equal(registry.owner({ sessionKey: "group-b-session" }), old);
  assert.equal(registry.updateResponseContexts(old, [change])[0].rejected, true);
  assert.equal(registry.resolveResponseContext("same-id", "m", "group-b").providerId, "b");
});

test("网络响应先结束时仍等待同会话全部完成检查点，避免遗漏最后的响应上下文", () => {
  const registry = createHandoffSessionRegistry(); const old = { id: "old" }; const next = { id: "new" };
  registry.registerWorker(old, "active");
  registry.beginRequest({ sessionKey: "s" }); registry.beginRequest({ sessionKey: "s" }); registry.beginHandoff(old, next);
  registry.finishRequest({ sessionKey: "s", worker: old, pendingRequestId: "r1" });
  registry.finishRequest({ sessionKey: "s", worker: old, pendingRequestId: "r2" });
  registry.checkpoint({ sessionKey: "s", worker: old, requestId: "r1", completed: true, responseIds: ["response-1"], providerId: "a" });
  assert.equal(registry.owner({ sessionKey: "s" }), old);
  assert.equal(registry.state().pendingCheckpoints, 1);
  registry.checkpoint({ sessionKey: "s", worker: old, requestId: "r2", completed: true, responseIds: ["response-2"], providerId: "b" });
  assert.equal(registry.owner({ sessionKey: "s" }), next);
  assert.equal(registry.resolveResponseContext("response-2").providerId, "b");
});

test("同分组同响应标识的不同模型不会相互覆盖", () => {
  const registry = createHandoffSessionRegistry(); const worker = { id: "worker" };
  registry.registerWorker(worker, "active");
  for (const model of ["a", "b"]) {
    const scope = responseContextScope("group", "cct", model);
    const sessionKey = extractSessionKey({ "x-session-id": "same" }, {}, model, "cct", "group").key;
    registry.beginRequest({ sessionKey, scope });
    registry.checkpoint({ sessionKey, worker, model, responseIds: ["same-id"], providerId: model });
    registry.finishRequest({ sessionKey, worker, completed: true });
  }
  for (const model of ["a", "b"]) assert.equal(registry.resolveResponseContext("same-id", model, responseContextScope("group", "cct", model)).providerId, model);
});

test("整体交接的排队请求按实际处理进程确认，迟到旧确认不把会话退回旧版", () => {
  const registry = createHandoffSessionRegistry(); const old = { id: "old" }; const next = { id: "next" };
  registry.registerWorker(old, "active");
  registry.beginRequest({ sessionKey: "s" }); registry.beginRequest({ sessionKey: "s" });
  registry.registerWorker(next, "active");
  assert.equal(registry.checkpoint({ sessionKey: "s", worker: next, completed: true, responseIds: ["new"], providerId: "b" }), false);
  assert.equal(registry.checkpoint({ sessionKey: "s", worker: next, completed: true, responseIds: ["new"], providerId: "b", allowCompletedRequest: true }), true);
  assert.equal(registry.checkpoint({ sessionKey: "s", worker: old, completed: true, responseIds: ["old"], providerId: "a", allowCompletedRequest: true }), true);
  assert.equal(registry.owner({ sessionKey: "s" }), next);
  assert.equal(registry.resolveResponseContext("new").providerId, "b");
  assert.equal(registry.resolveResponseContext("old").providerId, "a");
  registry.beginHandoff(next, old); registry.registerWorker(next, "active");
  assert.equal(registry.mode(), "process");
});
