/** 开发检查 HTTP 验收：本机假上游、独立数据，验证业务并行、持久报告、取消和保存失败不重复计费。 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDevelopmentProvider } from "../helpers/development-provider.mjs";
import { createCompatibilityReports } from "../../lib/compatibility-reports.js";
import { exportCompatibilityReport } from "../../lib/compatibility-report-format.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 300; n++) { const value = await check().catch(() => null); if (value) return value; await pause(20); } throw new Error("开发检查 HTTP 等待超时"); }
async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); assert.ok(server.address().port >= 15725); return server.address().port; }

test("固定供应商开发检查不干扰业务，报告跨重启可读、分组隔离且可判断过期", { timeout: 30000 }, async (t) => {
  const data = await mkdtemp(path.join(tmpdir(), "lite-development-http-"));
  const mock = createDevelopmentProvider(); let child; let hold = false; let release; let output = "";
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.tool_choice === "auto") {
      const items = mock.respond(body);
      if (hold) { await new Promise((resolve) => { release = resolve; }); if (res.destroyed) return; }
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(mock.stream(body, items));
    } else {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "business", status: "completed", model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    }
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer(); const port = await listen(reservation); await new Promise((resolve) => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  const base = `http://127.0.0.1:${port}`;
  const api = (route, options = {}) => fetch(base + route, { ...options, headers: { "x-lite-ccswitch-token": "admin-test", "content-type": "application/json", ...options.headers } });
  async function start() {
    child = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env: { ...env, LITE_CCSWITCH_DATA_DIR: data, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(port), LITE_CCSWITCH_ADMIN_TOKEN: "admin-test", LITE_CCSWITCH_PROXY_TOKEN: "proxy-test", LITE_CCSWITCH_RECOVERY_PROBE_INTERVAL_MS: "3600000" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    await until(async () => { assert.equal(child.exitCode, null, output); return (await api("/api/status")).ok; });
  }
  async function stop() { if (child && child.exitCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; } }
  t.after(async () => { hold = false; release?.(); await stop(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(data, { recursive: true, force: true }); });
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { currentProviderId: "mock", autoFailoverEnabled: false }, providers: [{ id: "mock", name: "模拟供应商", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "never-store-secret", routingEnabled: true }], connectivityTest: { periodicIntervalMs: null } }));
  await start();
  let savedConfig = await readFile(path.join(data, "config.json"), "utf8"); let before = await (await api("/api/status")).json();
  const post = { method: "POST", body: JSON.stringify({ model: "mock-model", mode: "development" }) };
  const noAuth = await fetch(base + "/api/providers/mock/compatibility/reports"); assert.equal(noAuth.status, 401); await noAuth.text();
  const invalid = await api("/api/providers/mock/compatibility", { method: "POST", body: JSON.stringify({ model: "mock", mode: "invalid" }) }); assert.equal(invalid.status, 400); await invalid.text();
  hold = true;
  const checking = api("/api/providers/mock/compatibility", post);
  await until(async () => Boolean(release));
  const duplicate = await api("/api/providers/mock/compatibility", post); assert.equal(duplicate.status, 409); await duplicate.text();
  const business = await api("/v1/responses", { method: "POST", headers: { "x-lite-ccswitch-token": "proxy-test" }, body: JSON.stringify({ model: "mock-model", input: "synthetic-business" }) }); assert.equal(business.status, 200); await business.text();
  await until(async () => (JSON.parse(await readFile(path.join(data, "config.json"), "utf8"))).providers[0].modelSupport?.supportedModels?.includes("mock-model"));
  savedConfig = await readFile(path.join(data, "config.json"), "utf8"); before = await (await api("/api/status")).json();
  hold = false; release(); release = null;
  const checked = await checking; assert.equal(checked.status, 200); const report = await checked.json();
  assert.equal(report.outcome, "passed"); assert.equal(report.saved, true); assert.equal(report.usage.totalTokens, 20); assert.equal(report.requestCount, 4);
  assert.deepEqual(report.requestTrace.map(({ step, protocol, statusCode, outcome }) => [step, protocol, statusCode, outcome]), [1, 2, 3, 4].map((round) => [`development-${round}`, "sse", 200, "completed"]));
  assert.deepEqual(report.steps.map((step) => step.target), ["input.json", "summary.json", "inspect", "result.json", "summary.json", "verify"]);
  assert.equal(report.steps.at(-1).exitCode, 0);
  assert.doesNotMatch(JSON.stringify(report), /never-store-secret|commandCode|ccslite-development-/);
  const initialBilling = await (await api("/api/billing/summary?groupId=default")).json();
  assert.equal(initialBilling.probes.totalRequests, 4);
  assert.equal(initialBilling.probes.totalTokens, 20);
  assert.equal(initialBilling.business.totalRequests, 1);
  assert.equal(initialBilling.ccok.totalRequests, 0);
  assert.equal((await (await api("/api/billing/trend?groupId=default")).json()).sampleCount, 1);
  assert.equal(report.schemaVersion, 1); assert.equal(report.definition.id, "ccslite.responses.development"); assert.equal(report.definition.version, 1);
  assert.equal(report.definition.protocol, "openai-responses"); assert.equal(report.environment.nodeVersion, process.version); assert.ok(report.latencyMs >= 0);
  assert.equal(await readFile(path.join(data, "config.json"), "utf8"), savedConfig);
  const after = await (await api("/api/status")).json(); assert.deepEqual(after.providers.map((item) => item.circuit), before.providers.map((item) => item.circuit));
  let history = await (await api("/api/providers/mock/compatibility/reports")).json(); assert.equal(history.total, 1); assert.equal(history.reports[0].stale, false);
  const detailUrl = `/api/providers/mock/compatibility/reports/${report.reportId}`;
  const persistedReport = await (await api(detailUrl)).json();
  assert.equal(persistedReport.reportId, report.reportId);
  assert.deepEqual(persistedReport.requestTrace, report.requestTrace);
  const callsBeforeExport = mock.requests.length;
  const exportUrl = detailUrl + "/export";
  const exportResponse = await api(exportUrl); assert.equal(exportResponse.status, 200); assert.match(exportResponse.headers.get("content-disposition"), /attachment/);
  const exported = await exportResponse.json(); assert.equal(exported.readiness, "verified_for_this_task"); assert.equal(exported.configuration, "matches"); assert.equal(exported.usage.totalTokens, 20);
  assert.doesNotMatch(JSON.stringify(exported), /never-store-secret|127\.0\.0\.1|模拟供应商|configFingerprint|providerId/);
  const noExportAuth = await fetch(base + exportUrl); assert.equal(noExportAuth.status, 401); await noExportAuth.text();
  const proxyExport = await api(exportUrl, { headers: { "x-lite-ccswitch-token": "proxy-test" } }); assert.equal(proxyExport.status, 401); await proxyExport.text();
  assert.equal(mock.requests.length, callsBeforeExport, "导出、查看和鉴权失败均不得再次请求供应商");
  const afterReportBusiness = await api("/v1/responses", { method: "POST", headers: { "x-lite-ccswitch-token": "proxy-test", "x-request-id": "after-report" }, body: JSON.stringify({ model: "mock-model", input: "synthetic-business" }) }); assert.equal(afterReportBusiness.status, 200); await afterReportBusiness.text();
  const logged = await until(async () => (await (await api("/api/billing/logs")).json()).records.find((item) => item.requestId === "after-report"));
  const evidencePath = `/api/billing/logs/${logged.id}/evidence`;
  const evidence = await (await api(evidencePath)).json(); assert.equal(evidence.reports[0].association, "matched"); assert.equal(evidence.reports[0].reports[0].reportId, report.reportId);
  const unauthorizedEvidence = await fetch(base + evidencePath); assert.equal(unauthorizedEvidence.status, 401); await unauthorizedEvidence.text();
  const groupResponse = await api("/api/groups", { method: "POST", body: JSON.stringify({ name: "报告隔离", listener: { enabled: false } }) }); const group = await groupResponse.json();
  assert.equal((await api(detailUrl + `?groupId=${group.id}`)).status, 404);
  assert.equal((await api(exportUrl + `?groupId=${group.id}`)).status, 404);
  assert.equal((await api(evidencePath + `?groupId=${group.id}`)).status, 404);
  assert.equal((await (await api(`/api/providers/mock/compatibility/reports?groupId=${group.id}`)).json()).total, 0);
  await api("/api/providers/mock", { method: "PUT", body: JSON.stringify({ sortIndex: 2, name: "改名" }) }); assert.equal((await (await api(detailUrl)).json()).stale, false);
  await api("/api/providers/mock", { method: "PUT", body: JSON.stringify({ apiKey: "changed-secret" }) }); assert.equal((await (await api(detailUrl)).json()).stale, true);
  await stop(); await start(); assert.equal((await (await api(detailUrl)).json()).stale, true);
  assert.equal((await (await api(exportUrl)).json()).configuration, "changed");
  // 取消真实在途 HTTP 检查，服务端仍保存摘要而不等待后续模型请求。
  hold = true; release = null; const controller = new AbortController();
  const cancelled = api("/api/providers/mock/compatibility", { ...post, signal: controller.signal }).catch(() => null);
  await until(async () => Boolean(release)); controller.abort(); await cancelled;
  await until(async () => { history = await (await api("/api/providers/mock/compatibility/reports")).json(); return history.reports.some((item) => item.outcome === "cancelled"); });
  hold = false; release(); release = null;
  // 报告目录不可用也不能重试模型；保留已完成结果和清晰提示。
  const reportDir = path.join(data, "compatibility-reports"); await rename(reportDir, reportDir + "-held"); await writeFile(reportDir, "blocked");
  const callsBefore = mock.requests.length;
  const unsaved = await (await api("/api/providers/mock/compatibility", post)).json(); assert.equal(unsaved.outcome, "passed"); assert.equal(unsaved.saved, false); assert.match(unsaved.saveError, /无需重复/); assert.equal(mock.requests.length - callsBefore, 4);
  assert.equal(exportCompatibilityReport(unsaved).readiness, "verified_for_this_task", "落盘失败时仍能导出本次内存结果");
  await unlink(reportDir); await rename(reportDir + "-held", reportDir);
  // 同一供应商另一分组的报告也单独存储。
  const grouped = await (await api(`/api/providers/mock/compatibility?groupId=${group.id}`, post)).json(); assert.equal(grouped.outcome, "passed");
  assert.equal((await api(`/api/providers/mock/compatibility/reports/${grouped.reportId}`)).status, 404);
  const legacy = await createCompatibilityReports(data).save({ providerId: "mock", groupId: "default", mode: "basic", model: "old-model", checkedAt: "2026-11-10T12:00:00.000Z", outcome: "passed", results: [], message: "never-export-error-secret" });
  const legacyExport = await (await api(`/api/providers/mock/compatibility/reports/${legacy.reportId}/export`)).json();
  assert.equal(legacyExport.definition, null); assert.equal(legacyExport.environment, null); assert.equal(legacyExport.readiness, "not_assessed"); assert.doesNotMatch(JSON.stringify(legacyExport), /never-export-error-secret/);
  const usage = (await readFile(path.join(data, "usage.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(usage.filter((item) => item.usageCategory === "compatibility_probe").length, 13);
  const rawReports = await (await api("/api/providers/mock/compatibility/reports")).text(); assert.doesNotMatch(rawReports, /never-store-secret|changed-secret|127\.0\.0\.1|commandCode/);
});
