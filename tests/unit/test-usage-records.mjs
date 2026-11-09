/**
 * 请求用量记录模块测试。
 * 验证 JSON/SSE Token 提取、计费模型归一化和历史记录重算行为。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProviderAttempt,
  detectFastBillingMode,
  extractRequestModel,
  extractUsage,
  isCcokProbeUsageRecord,
  normalizeProviderTestUsageRecord,
  normalizeBillingModel,
  normalizeUsageRecord,
} from "../../lib/usage-records.js";

test("从普通 JSON 响应提取模型与四类 Token", () => {
  const usage = extractUsage(Buffer.from(JSON.stringify({
    model: "gpt-5.6-terra",
    usage: {
      input_tokens: 1000,
      output_tokens: 40,
      total_tokens: 1040,
      input_tokens_details: {
        cached_tokens: 700,
        cache_write_tokens: 200,
      },
    },
  })), null);

  assert.equal(usage.model, "gpt-5.6-terra");
  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.ordinaryInputTokens, 100);
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.cacheReadTokens, 700);
  assert.equal(usage.cacheCreationTokens, 200);
});

test("从 SSE 响应保留最后且最完整的累计用量", () => {
  const usage = extractUsage(null, [
    'data: {"model":"gpt-5.6-sol","response":{"usage":{"input_tokens":10,"output_tokens":1}}}',
    'data: {"response":{"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}',
    "data: [DONE]",
  ].join("\n"));

  assert.equal(usage.model, "gpt-5.6-sol");
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.totalTokens, 120);
});

test("从嵌套 Responses 事件提取实际响应模型", () => {
  const usage = extractUsage(null, [
    'data: {"type":"response.created","response":{"model":"gpt-6-astra"}}',
    'data: {"type":"response.completed","response":{"model":"gpt-5.6-luna","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}',
    "data: [DONE]",
  ].join("\n"));

  assert.equal(usage.model, "gpt-5.6-luna");
  assert.equal(usage.totalTokens, 3);
});

test("请求模型和 priority 计费模式识别保持兼容", () => {
  const request = Buffer.from(JSON.stringify({
    model: "gpt-5.6-terra",
    service_tier: "priority",
  }));

  assert.equal(extractRequestModel(request), "gpt-5.6-terra");
  assert.equal(detectFastBillingMode(request, null, null), true);
  assert.equal(normalizeBillingModel("gpt-5.4-mini"), "gpt-5.5");
  assert.equal(normalizeBillingModel("gpt-5.6-terra"), "gpt-5.6-terra");
});

test("历史记录通过注入的价格函数重算并规范化尝试记录", () => {
  const record = normalizeUsageRecord({
    requestModel: "gpt-5.5",
    routeReason: "recovered_migration",
    billingMode: "fast",
    inputTokens: 100,
    cacheReadTokens: 40,
    outputTokens: 20,
    providerAttempts: [{
      providerId: "cx1",
      providerName: "cx1",
      outcome: "success",
      usage: { totalTokens: 120, usageObserved: true },
    }],
  }, {
    estimateCost: (_model, usage) => usage.ordinaryInputTokens / 100,
    fastModeMultiplier: 2.5,
  });

  assert.equal(record.ordinaryInputTokens, 60);
  assert.equal(record.baseEstimatedCostUsd, 0.6);
  assert.equal(record.estimatedCostUsd, 1.5);
  assert.equal(record.providerAttempts[0].failureClass, "");
  assert.equal(record.providerAttempts[0].usage.totalTokens, 120);
  assert.equal(record.routeReason, "recovered_migration");
});

test("供应商尝试会截断错误文本并保留流诊断", () => {
  const attempts = [];
  appendProviderAttempt(attempts, { id: "cx1", name: "cx1" }, {
    outcome: "failure",
    error: "x".repeat(2100),
    streamDiagnostics: {
      forwardedBytes: 42,
      firstByteAt: "2026-10-21T00:00:00.000Z",
      firstByteLatencyMs: 145,
      clientFirstByteLatencyMs: 1500,
      lastDataLatencyMs: 900,
      outputStarted: true,
      events: { totalEvents: 2, eventTypes: { completed: 1 } },
    },
  });

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].error.length, 2003);
  assert.equal(attempts[0].streamDiagnostics.forwardedBytes, 42);
  assert.equal(attempts[0].streamDiagnostics.firstByteLatencyMs, 145);
  assert.equal(attempts[0].streamDiagnostics.outputStarted, true);
  assert.equal(attempts[0].streamDiagnostics.events.eventTypes.completed, 1);
});

test("CCOK 记录保留真实供应商并标记独立流量类别", () => {
  const normalized = normalizeProviderTestUsageRecord({
    providerId: "cx1",
    providerName: "cx1",
    endpoint: "/v1/responses#provider-test",
    requestModel: "gpt-5.6-luna",
  });

  assert.equal(normalized.providerId, "cx1");
  assert.equal(normalized.providerName, "cx1");
  assert.equal(normalized.usageCategory, "ccok_probe");
  assert.equal(normalized.targetProviderId, "cx1");
  assert.equal(normalized.targetProviderName, "cx1");
  assert.equal(isCcokProbeUsageRecord(normalized), true);
});

test("旧版 CCOK 虚拟供应商记录读取时恢复真实供应商", () => {
  const normalized = normalizeProviderTestUsageRecord({
    providerId: "__ccok_probe__",
    providerName: "CCOK 探测",
    targetProviderId: "cx2",
    targetProviderName: "cx2",
    endpoint: "/v1/responses#provider-test",
  });

  assert.equal(normalized.providerId, "cx2");
  assert.equal(normalized.providerName, "cx2");
  assert.equal(normalized.usageCategory, "ccok_probe");
});
