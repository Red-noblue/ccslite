/** 报告导出验收：白名单阻止嵌套敏感信息泄露，区分基础通过、开发任务证据与未知历史定义。 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCompatibilityMetadata, exportCompatibilityReport } from "../../lib/compatibility-report-format.js";

function complete(mode = "development") {
  const metadata = createCompatibilityMetadata(mode, { ccsliteVersion: "0.2.20-rc.4", nodeVersion: "v18.20.8", platform: "linux", arch: "x64" });
  return { ...metadata, mode, model: "example-model", checkedAt: "2026-11-11T10:00:00.000Z", requestCount: 4, latencyMs: 3500, outcome: "passed", stale: false,
    results: metadata.definition.capabilities.map((key) => ({ key, outcome: "passed" })), usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, steps: [{ round: 1, tool: "read_file", ok: true }] };
}

test("脱敏导出仅保留可解释的证据，所有层级的动态字段均不透传", () => {
  const report = complete(); const secret = "DO_NOT_EXPORT_SECRET";
  for (const key of ["providerId", "providerName", "groupId", "reportId", "baseUrl", "apiKey", "configFingerprint", "message", "saveError", "headers", "request", "response"]) report[key] = secret;
  report.definition.extra = secret; report.definition.capabilities.push(secret);
  report.environment.extra = secret; report.usage.extra = secret;
  report.budget = { maxRequests: 8, extra: secret, requestTimeoutMs: secret };
  report.results.forEach((item) => { item.message = secret; item.response = { apiKey: secret }; });
  report.results.push({ key: secret, outcome: "passed", message: secret });
  report.requestTrace = [{ sequence: 1, step: "development-1", protocol: "sse", statusCode: 200, firstByteMs: 50, responseBytes: 120, latencyMs: 70, outcome: "completed", outward: secret }];
  report.steps[0].detail = secret; report.steps[0].message = secret; report.steps[0].arguments = { apiKey: secret };
  const exported = exportCompatibilityReport(report);
  assert.doesNotMatch(JSON.stringify(exported), new RegExp(secret));
  assert.equal(exported.readiness, "verified_for_this_task");
  assert.equal(exported.definition.capabilities.length, 6);
  assert.deepEqual(exported.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  assert.equal(exported.budget.requestTimeoutMs, null);
  assert.equal(exported.configuration, "matches");
  assert.equal(exported.steps[0].ok, true);
  assert.deepEqual(exported.requestTrace[0], { sequence: 1, step: "development-1", protocol: "sse", statusCode: 200, firstByteMs: 50, responseBytes: 120, latencyMs: 70, outcome: "completed" });
});

test("基础通过、旧报告和缺少操作证据均不能宣称开发就绪", () => {
  assert.equal(exportCompatibilityReport(complete("basic")).readiness, "not_assessed");
  const legacy = complete(); delete legacy.schemaVersion; delete legacy.definition; delete legacy.environment;
  const exported = exportCompatibilityReport(legacy);
  assert.equal(exported.definition, null); assert.equal(exported.environment, null); assert.equal(exported.outcome, "passed"); assert.equal(exported.readiness, "not_verified");
  for (const status of ["failed", "inconclusive", "cancelled"]) assert.equal(exportCompatibilityReport({ ...complete(), outcome: status }).readiness, "not_verified");
  const missing = complete(); missing.results.pop(); assert.equal(exportCompatibilityReport(missing).readiness, "not_verified");
  const duplicate = complete(); duplicate.results.push(duplicate.results[0]); assert.equal(exportCompatibilityReport(duplicate).readiness, "not_verified");
  const unknown = complete(); unknown.definition.version = 2; assert.equal(exportCompatibilityReport(unknown).definition, null); assert.equal(exportCompatibilityReport(unknown).readiness, "not_verified");
  const stale = exportCompatibilityReport({ ...complete(), stale: true }); assert.equal(stale.configuration, "changed"); assert.equal(stale.readiness, "verified_for_this_task");
});

test("非法数值、环境和结果枚举不会混入导出字段", () => {
  const report = complete(); report.usage.totalTokens = -1; report.latencyMs = Infinity; report.checkedAt = "invalid";
  report.environment.platform = "secret-path"; report.environment.nodeVersion = "secret-version";
  report.results[0].outcome = "secret-error"; report.steps.push({ round: -1, tool: "secret-command", ok: "yes" });
  const exported = exportCompatibilityReport(report);
  assert.equal(exported.usage.totalTokens, null); assert.equal(exported.latencyMs, null); assert.equal(exported.checkedAt, null);
  assert.equal(exported.environment.platform, null); assert.equal(exported.environment.nodeVersion, null);
  assert.equal(exported.results[0].outcome, "inconclusive"); assert.equal(exported.readiness, "not_verified");
  assert.deepEqual(exported.steps[1], { round: null, tool: "unknown", ok: false, target: "", exitCode: null });
  assert.doesNotMatch(JSON.stringify(exported), /secret-/);
});
