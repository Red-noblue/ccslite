/** 隔离 HTTP 验收：故障转移日志保留候选快照，兼容检查受鉴权保护且不改变路由健康。 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server.address().port; }
async function until(action) { for (let n = 0; n < 100; n++) { const result = await action().catch(() => null); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 30)); } throw new Error("隔离服务等待超时"); }
const message = (text) => ({ type: "message", content: [{ type: "output_text", text }] });

test("业务故障转移和手动兼容检查完整 HTTP 场景", async (t) => {
  const data = await mkdtemp(path.join(tmpdir(), "lite-request-diagnostics-"));
  let upstreamCalls = 0; let marker; let child; let output = "";
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); upstreamCalls += 1;
    if (req.url.startsWith("/fail")) { res.writeHead(503); res.end("simulated failure"); return; }
    let items = [message("CCOK")];
    if (body.tool_choice?.name) items = [{ type: "function_call", name: "ccslite_compat_ping", call_id: "call-http", arguments: "{}" }];
    if (body.tool_choice === "none") items = [message(body.input.find((item) => item.type === "function_call_output").output)];
    if (body.store && !body.previous_response_id) { marker = body.input[0].content[0].text.match(/CTX_[a-f0-9]+/)[0]; items = [message("OK")]; }
    if (body.previous_response_id) items = [message(marker)];
    const response = { id: "resp-http", model: body.model, status: "completed", output: items, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
    res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
    res.end(body.stream ? `data: ${JSON.stringify({ type: "response.completed", response })}\n\n` : JSON.stringify(response));
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer(); const port = await listen(reservation); await new Promise((resolve) => reservation.close(resolve));
  t.after(async () => {
    if (child && child.exitCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    await rm(data, { recursive: true, force: true });
  });
  const baseProvider = { apiKey: "fake-test-secret", authMode: "api_key", routingEnabled: true };
  await writeFile(path.join(data, "config.json"), JSON.stringify({
    version: 2,
    proxy: { autoFailoverEnabled: true, preferredProviderMaxAttempts: 1, providerMaxAttempts: 1, maxAttempts: 2, providerRetryDelayMs: 1, preferredProviderRetryDelayMs: 1 },
    providers: [
      { ...baseProvider, id: "fail", name: "优先失败", sortIndex: 1, baseUrl: `http://127.0.0.1:${upstreamPort}/fail` },
      { ...baseProvider, id: "ok", name: "后备成功", sortIndex: 2, baseUrl: `http://127.0.0.1:${upstreamPort}` },
      { ...baseProvider, id: "disabled", name: "已关闭", sortIndex: 3, routingEnabled: false, baseUrl: `http://127.0.0.1:${upstreamPort}` },
      { ...baseProvider, id: "unsupported", name: "不支持", sortIndex: 4, baseUrl: `http://127.0.0.1:${upstreamPort}`, modelSupport: { unsupportedModels: ["mock-model"], lastTestedAt: new Date().toISOString() } },
      { ...baseProvider, id: "missing", name: "无地址", sortIndex: 5 },
    ], connectivityTest: { periodicIntervalMs: null },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env: { ...env, LITE_CCSWITCH_DATA_DIR: data, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(port), LITE_CCSWITCH_ADMIN_TOKEN: "admin-test", LITE_CCSWITCH_PROXY_TOKEN: "proxy-test", LITE_CCSWITCH_RECOVERY_PROBE_INTERVAL_MS: "3600000" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-lite-ccswitch-token": "admin-test", "content-type": "application/json" };
  const api = async (route, options = {}) => fetch(base + route, { ...options, headers: { ...headers, ...options.headers } });
  await until(async () => { assert.equal(child.exitCode, null, output); return (await api("/api/status")).ok; });
  const business = await api("/v1/responses", { method: "POST", headers: { "x-lite-ccswitch-token": "proxy-test" }, body: JSON.stringify({ model: "mock-model", input: "synthetic", stream: false }) });
  assert.equal(business.status, 200); await business.text();
  const logs = await until(async () => { const result = await (await api("/api/billing/logs?page=1&pageSize=30")).json(); return result.records?.length ? result.records : null; });
  const log = logs[0];
  assert.equal(log.providerId, "ok"); assert.equal(log.routeReason, "failover");
  assert.deepEqual(log.providerAttempts.map((attempt) => [attempt.providerId, attempt.outcome]), [["fail", "failure"], ["ok", "success"]]);
  assert.deepEqual(log.routeSnapshot.candidates.map((provider) => provider.providerId), ["fail", "ok"]);
  assert.deepEqual(log.routeSnapshot.excluded.map((provider) => provider.reason), ["routing_disabled", "model_unsupported", "not_configured"]);
  assert.doesNotMatch(JSON.stringify(log.routeSnapshot), /fake-test-secret|http:/);
  const streaming = await api("/v1/responses", { method: "POST", headers: { "x-lite-ccswitch-token": "proxy-test" }, body: JSON.stringify({ model: "mock-model", input: "synthetic", stream: true }) });
  assert.equal(streaming.status, 200); assert.match(await streaming.text(), /response.completed/);
  await until(async () => {
    const result = await (await api("/api/billing/logs?page=1&pageSize=30")).json();
    const streamLog = result.records.find((item) => item.isStreaming);
    if (!streamLog) return false;
    assert.equal(streamLog.routeSnapshot.version, 1);
    assert.equal(streamLog.providerAttempts.at(-1).streamDiagnostics.events.completed, true);
    return true;
  });
  const before = await until(async () => { const status = await (await api("/api/status")).json(); return status.activeConnections === 0 ? status : null; });
  const savedBefore = await readFile(path.join(data, "config.json"), "utf8");
  const callsBefore = upstreamCalls;
  const unauthorized = await fetch(base + "/api/providers/ok/compatibility", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "mock-model" }) });
  assert.equal(unauthorized.status, 401); await unauthorized.text();
  const invalid = await api("/api/providers/ok/compatibility", { method: "POST", body: JSON.stringify({}) });
  assert.equal(invalid.status, 400); await invalid.text(); assert.equal(upstreamCalls, callsBefore);
  const response = await api("/api/providers/ok/compatibility", { method: "POST", body: JSON.stringify({ model: "mock-model" }) });
  assert.equal(response.status, 200);
  const report = await response.json(); assert.equal(report.requestCount, 5);
  assert.deepEqual(report.results.map((item) => item.outcome), ["passed", "passed", "passed"]);
  assert.equal(upstreamCalls - callsBefore, 5);
  const after = await (await api("/api/status")).json();
  assert.deepEqual(after.providers.map((provider) => provider.circuit), before.providers.map((provider) => provider.circuit));
  assert.equal(await readFile(path.join(data, "config.json"), "utf8"), savedBefore);
  const groupResponse = await api("/api/groups", { method: "POST", body: JSON.stringify({ name: "兼容检查隔离组", listener: { enabled: false } }) });
  assert.equal(groupResponse.status, 201); const group = await groupResponse.json();
  const groupConfigBefore = await readFile(path.join(data, "config.json"), "utf8");
  const groupCheck = await api(`/api/providers/ok/compatibility?groupId=${group.id}`, { method: "POST", body: JSON.stringify({ model: "mock-model" }) });
  assert.equal(groupCheck.status, 200); assert.equal((await groupCheck.json()).requestCount, 5);
  assert.equal(await readFile(path.join(data, "config.json"), "utf8"), groupConfigBefore);
  const groupLogs = await (await api(`/api/billing/logs?groupId=${group.id}&page=1&pageSize=30`)).json();
  assert.equal(groupLogs.records.length, 5); assert.ok(groupLogs.records.every((item) => item.groupId === group.id));
  const usage = (await readFile(path.join(data, "usage.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(usage.filter((item) => item.usageCategory === "compatibility_probe" && item.groupId === "default").length, 5);
  assert.equal(usage.filter((item) => item.usageCategory === "compatibility_probe" && item.groupId === "default").reduce((sum, item) => sum + item.totalTokens, 0), 25);
});

