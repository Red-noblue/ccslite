/** 路由诊断测试：保留当时的候选顺序、排除原因，并过滤认证等无关字段。 */
import assert from "node:assert/strict";
import test from "node:test";
import { captureRouteSnapshot, normalizeRouteSnapshot } from "../../lib/route-diagnostics.js";
import { normalizeUsageRecord } from "../../lib/usage-records.js";
import { attemptStage, requestOutcome, routeReasonText, requestExplanation } from "../../web/src/components/request-diagnostics.js";

test("快照忠实记录选路结果，且不携带密钥、链接和正文", () => {
  const providers = [
    { id: "a", name: "优先", sortIndex: 1, baseUrl: "https://example.invalid", routingEnabled: true, apiKey: "secret-a" },
    { id: "b", name: "粘滞", sortIndex: 2, baseUrl: "https://example.invalid", routingEnabled: true },
    { id: "off", routingEnabled: false, baseUrl: "https://example.invalid" },
    { id: "open", routingEnabled: true, baseUrl: "https://example.invalid" },
    { id: "missing", routingEnabled: true },
    { id: "model", routingEnabled: true, baseUrl: "https://example.invalid", modelSupport: { modelEvidence: { test: { state: "unsupported", source: "test", checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } } } },
  ];
  const snapshot = captureRouteSnapshot({ providers, selected: [providers[1], providers[0]], proxy: { autoFailoverEnabled: true }, routeKey: "cct", model: "test", stickyProviderId: "b", circuitState: (id) => id === "open" ? "open" : "closed" });
  assert.deepEqual(snapshot.candidates.map((p) => p.providerId), ["b", "a"]);
  assert.deepEqual(snapshot.excluded.map((p) => p.reason), ["routing_disabled", "circuit_open", "not_configured", "model_unsupported"]);
  providers[1].sortIndex = 5;
  assert.equal(snapshot.candidates[0].priority, 2);
  const safe = normalizeRouteSnapshot({ ...snapshot, apiKey: "secret", candidates: [{ ...snapshot.candidates[0], apiKey: "secret", baseUrl: "https://private.invalid" }] });
  assert.doesNotMatch(JSON.stringify(safe), /secret|https|apiKey/);
});

test("过程说明区分输出前切换和输出后失败，不把 HTTP 200 或恢复确认当成成功", () => {
  const attempts = [{ providerName: "甲", outcome: "failure", streamDiagnostics: { outputStarted: false } }, { providerName: "乙", outcome: "success", streamDiagnostics: { events: { completed: true } } }];
  assert.match(requestExplanation({ providerName: "乙", providerAttempts: attempts }).join(""), /有效输出前失败.*继续下一次尝试.*完整流式结束/);
  assert.match(requestExplanation({ error: "cut", statusCode: 200, providerAttempts: [{ ...attempts[0], streamDiagnostics: { outputStarted: true } }] }).join(""), /输出已开始后失败.*无法.*拼接.*失败/);
  assert.match(requestExplanation({ statusCode: 200 }).join(""), /完整性未记录/);
});

test("旧日志不根据当前配置补写历史证据，HTTP 200 不能掩盖断流", () => {
  assert.equal(normalizeUsageRecord({ statusCode: 200 }).routeSnapshot, null);
  assert.equal(routeReasonText(""), "当时未记录");
  assert.equal(requestOutcome({ statusCode: 200 }), "完整性未记录");
  assert.equal(requestOutcome({ statusCode: 200, error: "断流" }), "失败");
  assert.match(attemptStage({ outcome: "failure", statusCode: 200, streamDiagnostics: { outputStarted: true } }), /不能拼接/);
  assert.match(attemptStage({ outcome: "failure", streamDiagnostics: { outputStarted: false } }), /尚未输出/);
});
