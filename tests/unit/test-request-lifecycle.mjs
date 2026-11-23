/**
 * 请求生命周期登记器测试。
 * 验证流式数据新鲜度、敏感字段隔离、取消和幂等结束行为。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRequestLifecycleRegistry, readCodexSessionId } from "../../lib/request-lifecycle.js";

test("只读取可识别的 Codex 线程或会话标识，不使用请求追踪或缓存 ID", () => {
  const id = "019b0000-1111-7222-8333-444444444444";
  const legacyId = "019b0000-2222-7333-8444-555555555555";
  assert.equal(readCodexSessionId({ originator: "codex_cli_rs", "thread-id": id, "x-codex-session-id": legacyId }), id);
  assert.equal(readCodexSessionId({ "user-agent": "codex_cli_rs/0.167.2", "thread-id": id }), id);
  assert.equal(readCodexSessionId({ "x-codex-session-id": legacyId }), legacyId);
  assert.equal(readCodexSessionId({ "x-request-id": id, "prompt-cache-key": id, "thread-id": id }), null);
  assert.equal(readCodexSessionId({ originator: "codex_cli_rs", "thread-id": `${id}, ${legacyId}` }), null);
});

test("登记器记录流式数据时间和字节统计，但不保存请求正文", () => {
  let clock = 1000;
  const registry = createRequestLifecycleRegistry({ now: () => clock });
  const request = registry.start({
    requestId: "req-1",
    groupId: "default",
    providerId: "cx1",
    providerName: "cx1",
    model: "gpt-test",
    endpoint: "/v1/responses",
    stream: true,
    clientAddress: "127.0.0.1",
    clientPort: 1234,
  });

  clock = 1500;
  request.observeChunk(64, { state: "probing" });
  clock = 2200;
  request.observeChunk(128, { state: "streaming", semanticStarted: true });
  const current = registry.stats({ idleTimeoutMs: 1000 });

  assert.equal(current.active, 1);
  assert.equal(current.stale, 0);
  assert.equal(current.requests[0].totalBytes, 192);
  assert.equal(current.requests[0].chunkCount, 2);
  assert.equal(current.requests[0].lastChunkBytes, 128);
  assert.equal(current.requests[0].semanticStarted, true);
  assert.equal(current.requests[0].firstByteLatencyMs, 500);
  assert.equal(current.requests[0].clientFirstByteAt, null);
  assert.equal(current.requests[0].idleMs, 0);
  assert.equal("body" in current.requests[0], false);
  assert.equal("authorization" in current.requests[0], false);

  clock = 2400;
  request.markClientOutputStarted();
  assert.equal(registry.get(request.id).clientFirstByteLatencyMs, 1400);
  assert.equal(request.timingDiagnostics().lastDataLatencyMs, 1200);
});

test("静默流可被识别为 stale，取消只触发当前请求的 abort", () => {
  let clock = 1000;
  let abortCount = 0;
  const registry = createRequestLifecycleRegistry({ now: () => clock });
  const request = registry.start({ providerId: "a", stream: true });
  request.setAbort(() => { abortCount += 1; });
  request.observeChunk(10);
  clock = 2501;

  assert.equal(registry.stats({ idleTimeoutMs: 1000 }).stale, 1);
  const cancelled = registry.cancel(request.id);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(abortCount, 1);
  assert.equal(request.isCancelled(), true);
  assert.equal(registry.stats().active, 1);

  assert.equal(request.finish({ state: "cancelled", terminationReason: "operator_cancelled" }), true);
  assert.equal(request.finish({ state: "cancelled" }), false);
  assert.equal(registry.stats().active, 0);
});

test("心跳保持数据新鲜度，但不会重置无有效进展时长", () => {
  let clock = 1000;
  const registry = createRequestLifecycleRegistry({ now: () => clock });
  const request = registry.start({ stream: true });
  request.observeChunk(10, { progress: true, semanticStarted: true });
  clock = 2500;
  request.observeChunk(10, { progress: false, semanticStarted: true });
  const current = registry.get(request.id);
  assert.equal(current.idleMs, 0);
  assert.equal(current.noProgressMs, 1500);
  assert.equal(current.lastProgressAt, new Date(1000).toISOString());
});

