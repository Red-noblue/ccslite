/** 旧前置器上线演练：隔离数据与本机假上游，升级候选、取消检查、长流排空及固定备份回退均不影响生产。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDevelopmentProvider } from "../helpers/development-provider.mjs";
import { createCompatibilityReports } from "../../lib/compatibility-reports.js";
import { createRecoveryEvidence } from "../../lib/recovery-evidence.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const production = path.basename(path.dirname(root)) === "releases" ? path.resolve(root, "../..") : root;
const baseline = process.env.LITE_DEVELOPMENT_BASELINE || path.join(production, "releases/0.2.19-architecture-20261109");
const candidate = process.env.LITE_DEVELOPMENT_CANDIDATE || path.join(production, "releases/0.2.20-rc.5-evidence-20261111");
const fixed = process.env.LITE_DEVELOPMENT_FALLBACK || path.join(production, "fallback-releases/0.2.18-response-context-20261106");
const { createHandoffSupervisor } = await import(pathToFileURL(path.join(baseline, "lib/handoff-supervisor.js")));
const data = await mkdtemp(path.join(tmpdir(), "lite-development-handoff-"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch {} await pause(25); } throw new Error("开发检查交接演练超时"); }
async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); assert.ok(server.address().port >= 15725); return server.address().port; }
const mock = createDevelopmentProvider(); const holds = new Map(); let supervisor; let holdCheck = false; let releaseCheck; let reading;
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString());
  if (body.tool_choice === "auto") {
    const items = mock.respond(body);
    if (holdCheck) { await new Promise((resolve) => { releaseCheck = resolve; }); if (res.destroyed) return; }
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end(mock.stream(body, items)); return;
  }
  const response = { id: `resp-${body.input}`, status: "completed", model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 1 } };
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"type":"response.created"}\n\n');
    const timer = setInterval(() => res.write('data: {"type":"response.output_text.delta","delta":"working"}\n\n'), 40);
    holds.set(body.input, () => { clearInterval(timer); res.end(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`); }); res.once("close", () => clearInterval(timer));
  } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response)); }
});
try {
  const upstreamPort = await listen(upstream); const reservation = createServer(); const publicPort = await listen(reservation); await new Promise((resolve) => reservation.close(resolve));
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false, currentProviderId: "mock" }, providers: [{ id: "mock", name: "模拟", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "test-only" }], groups: [{ id: "default", name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "mock", enabled: true, sortIndex: 1 }] }], connectivityTest: { periodicIntervalMs: null } }));
  const store = createCompatibilityReports(data);
  await store.save({ groupId: "default", providerId: "mock", mode: "basic", model: "mock-model", checkedAt: new Date().toISOString(), requestCount: 0, outcome: "passed", results: [], steps: [] });
  const logs = [];
  supervisor = await createHandoffSupervisor({ candidate: baseline, fallback: fixed, dataDir: data, publicPort, observeMs: 300, healthPolicy: { intervalMs: 100 }, log: (event) => logs.push(event) });
  await supervisor.start(); const frontPid = process.pid; const base = `http://127.0.0.1:${publicPort}`;
  const api = (route, options = {}) => fetch(base + route, { ...options, headers: { "content-type": "application/json", ...options.headers } });
  const business = (session, input, stream = false) => api("/v1/responses", { method: "POST", headers: { originator: "codex_cli_rs", "thread-id": session, "x-request-id": input }, body: JSON.stringify({ model: "mock-model", input, stream }) });
  const long = await business("old", "old-stream", true); assert.equal(long.status, 200); reading = long.text();
  await supervisor.upgradeSession(candidate);
  const codexSessionId = "019b0000-5555-7666-8777-888888888888";
  const fresh = await business(codexSessionId, "after-upgrade", true);
  assert.equal(fresh.status, 200);
  const liveState = await (await api("/api/status")).json();
  assert.equal(liveState.activeRequests.requests.find((item) => item.requestId === "after-upgrade")?.codexSessionId, codexSessionId);
  holds.get("after-upgrade")(); assert.match(await fresh.text(), /response.completed/);
  assert.equal(supervisor.current().id, path.basename(candidate));
  const checked = await api("/api/providers/mock/compatibility", { method: "POST", body: JSON.stringify({ model: "mock-model", mode: "development" }) });
  assert.equal(checked.status, 200); const report = await checked.json(); assert.equal(report.outcome, "passed"); assert.equal(report.saved, true);
  assert.equal((await (await api(`/api/providers/mock/compatibility/reports/${report.reportId}`)).json()).reportId, report.reportId);
  const callsBeforeExport = mock.requests.length;
  const exported = await (await api(`/api/providers/mock/compatibility/reports/${report.reportId}/export`)).json();
  assert.equal(exported.readiness, "verified_for_this_task"); assert.equal(exported.definition.version, 1);
  assert.equal(mock.requests.length, callsBeforeExport); assert.doesNotMatch(JSON.stringify(exported), /test-only|127\.0\.0\.1|providerId|configFingerprint/);
  const afterReport = await business(codexSessionId, "evidence-after-report"); assert.equal(afterReport.status, 200); await afterReport.text();
  const linkedLog = await until(async () => (await (await api("/api/billing/logs")).json()).records.find((item) => item.requestId === "evidence-after-report"));
  const linked = await (await api(`/api/billing/logs/${linkedLog.id}/evidence`)).json();
  assert.equal(linked.reports[0].association, "matched"); assert.ok(linked.reports[0].reports.some((item) => item.reportId === report.reportId));
  const recoveryHistory = await (await api("/api/routing/recovery-events")).json();
  assert.ok(recoveryHistory.events.some((item) => item.kind === "confirmed" && item.successCount === 2));
  // 在固定监听器后取消，服务端也必须保存取消摘要。
  holdCheck = true; const controller = new AbortController();
  const cancelling = api("/api/providers/mock/compatibility", { method: "POST", signal: controller.signal, body: JSON.stringify({ model: "mock-model", mode: "development" }) }).catch(() => null);
  await until(async () => Boolean(releaseCheck)); controller.abort(); await cancelling;
  await until(async () => (await store.list("default", "mock")).reports.some((item) => item.outcome === "cancelled"));
  holdCheck = false; releaseCheck();
  holds.get("old-stream")(); assert.match(await reading, /response.completed/); reading = null;
  await until(async () => supervisor.state().session.legacyWorkerCount === 0);
  const stored = (await store.list("default", "mock")).total;
  const rollback = await supervisor.rollback();
  assert.equal(supervisor.current().id, path.basename(fixed));
  const fallbackResponse = await business("after-rollback", "fixed-fallback"); assert.equal(fallbackResponse.status, 200); await fallbackResponse.text();
  assert.equal((await store.list("default", "mock")).total, stored);
  assert.deepEqual((await createRecoveryEvidence(data).list("default")).events, recoveryHistory.events, "固定备份回退不能删除新版本的恢复归档");
  const usage = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(new Set(usage.map((item) => item.id)).size, usage.length);
  assert.equal(usage.filter((item) => item.usageCategory === "compatibility_probe").length, 5);
  assert.equal(usage.filter((item) => item.usageCategory !== "compatibility_probe").length, 4);
  console.log(JSON.stringify({ passed: true, node: process.version, baseline: path.basename(baseline), candidate: path.basename(candidate), fixed: path.basename(fixed), frontPid, publicPort, developmentRequests: mock.requests.length, reports: stored, usageRecords: usage.length, rollback: Boolean(rollback), requestEvidenceLinked: true, recoveryArchivePreserved: true, productionChanged: false }, null, 2));
} finally {
  holdCheck = false; releaseCheck?.(); for (const finish of holds.values()) finish(); await reading;
  await supervisor?.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(data, { recursive: true, force: true });
}
