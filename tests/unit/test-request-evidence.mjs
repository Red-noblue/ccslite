/** 请求证据关联验收：严格校验组、模型、配置和完成时间；旧数据缺失时明确未知，不倒推历史。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCompatibilityReports, compatibilityFingerprint, compatibilityFingerprintFromHeaders } from "../../lib/compatibility-reports.js";
import { buildUpstreamHeaders } from "../../lib/upstream-request.js";
import { buildRequestEvidence } from "../../lib/request-evidence.js";

test("实际认证头摘要与报告一致，不重复读取 OAuth 文件", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "lite-request-fingerprint-"));
  const previousOAuthHome = process.env.LITE_CCSWITCH_OAUTH_FILE_HOME;
  process.env.LITE_CCSWITCH_OAUTH_FILE_HOME = data;
  try {
    const oauthFilePath = path.join(data, "auth.json"); await writeFile(oauthFilePath, JSON.stringify({ tokens: { access_token: "secret-token", account_id: "secret-account" } }));
    for (const provider of [
      { authMode: "api_key", apiKey: "secret", customHeaders: {} },
      { authMode: "api_key", apiKey: "secret", customHeaders: { Authorization: "custom-secret" } },
      { authMode: "client_session", sessionHeaders: ["authorization"], sessionTtlMs: 60000 },
      { authMode: "oauth_file", oauthFilePath },
    ]) {
      const client = { headers: { authorization: "Bearer session-secret" } };
      const headers = await buildUpstreamHeaders(client, provider);
      const session = provider.authMode === "client_session" ? { authorization: "Bearer session-secret" } : undefined;
      if (provider.customHeaders?.Authorization) assert.equal(compatibilityFingerprintFromHeaders(provider, headers), "", "业务与手动检查存在认证覆盖差异时必须标记未知，不能错误关联");
      else assert.equal(compatibilityFingerprintFromHeaders(provider, headers), await compatibilityFingerprint(provider, session));
    }
  } finally {
    if (previousOAuthHome === undefined) delete process.env.LITE_CCSWITCH_OAUTH_FILE_HOME; else process.env.LITE_CCSWITCH_OAUTH_FILE_HOME = previousOAuthHome;
    await rm(data, { recursive: true, force: true });
  }
});

test("报告只关联请求开始前已完成的同模型同配置报告，旧日志保持未知", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "lite-request-evidence-"));
  try {
    const reports = createCompatibilityReports(data);
    const base = { groupId: "default", providerId: "a", model: "m", configFingerprint: "same", checkedAt: new Date(Date.now() - 1000).toISOString(), outcome: "passed", mode: "basic", results: [] };
    const valid = await reports.save(base);
    await reports.save({ ...base, configFingerprint: "changed" });
    await reports.save({ ...base, model: "other" });
    await reports.save({ ...base, mode: "development", checkedAt: "2099-01-01T00:00:00.000Z" });
    await reports.save({ ...base, groupId: "other" });
    const found = await reports.findForRequest("default", "a", { model: "m", configFingerprint: "same", before: new Date(Date.now() + 1).toISOString() });
    assert.deepEqual(found.reports.map((item) => item.reportId), [valid.reportId]);
    const tooEarly = await reports.findForRequest("default", "a", { model: "m", configFingerprint: "same", before: "2020-01-01T00:00:00.000Z" }); assert.equal(tooEarly.reports.length, 0);
    assert.equal((await reports.findForRequest("default", "a", {})).association, "not_recorded");
    const log = { groupId: "default", requestModel: "m", requestStartedAt: new Date(Date.now() + 1).toISOString(), providerAttempts: [{ providerId: "a", providerName: "甲", configFingerprint: "same", startedAt: new Date(Date.now() + 1).toISOString(), outcome: "success" }] };
    const evidence = await buildRequestEvidence(log, { compatibilityReports: reports, recoveryEvidence: { read: async () => null } });
    assert.equal(evidence.reports[0].reports[0].reportId, valid.reportId);
    assert.equal(evidence.reports[0].reports[0].configuration, "matches");
    assert.doesNotMatch(JSON.stringify(evidence), /configFingerprint/);
    const unknown = await buildRequestEvidence({ ...log, providerAttempts: [{ ...log.providerAttempts[0], configFingerprint: "" }] }, { compatibilityReports: reports, recoveryEvidence: {} });
    assert.equal(unknown.reports[0].association, "not_recorded");
    const duringRequest = await buildRequestEvidence({ ...log, requestStartedAt: "2020-01-01T00:00:00.000Z" }, { compatibilityReports: reports, recoveryEvidence: {} });
    assert.equal(duringRequest.reports[0].association, "no_match", "请求之后、备用尝试之前才完成的报告也不能当成请求前证据");
  } finally { await rm(data, { recursive: true, force: true }); }
});
