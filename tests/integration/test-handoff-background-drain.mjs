/**
 * 中文后台诊断交接验收：只读准备超时后恢复旧版，迟到任务不能再次切换只读。
 * 使用独立数据和本机假上游，验证正常停止等候诊断结果落盘，不调用真实供应商。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; assert.ok(port >= 15725); return port;
}
async function until(check) {
  for (let i = 0; i < 400; i += 1) { const value = await check(); if (value) return value; await pause(10); }
  throw new Error("等待后台诊断超时");
}

test("迟到的只读准备不会覆盖恢复激活，停止等待后台诊断落盘", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-background-")); const data = path.join(root, "data"); await mkdir(data);
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "background-a"); await createReleaseSnapshot(ROOT, fallback, "background-b");
  let trigger = false; let holdNext = false; let release = null; let calls = 0;
  const completed = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ output_text: "OK", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } })); };
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; } calls += 1;
    if (trigger) { trigger = false; holdNext = true; res.writeHead(413, { "content-type": "application/json" }); res.end('{"error":{"message":"测试请求过大"}}'); return; }
    if (holdNext) { holdNext = false; release = () => { completed(res); release = null; }; return; }
    completed(res);
  });
  const upstreamPort = await listen(upstream); const reserve = createServer(); const publicPort = await listen(reserve); await new Promise((resolve) => reserve.close(resolve));
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const events = []; const supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, controlTimeoutMs: 400, log: (line) => events.push(line) });
  t.after(async () => { release?.(); await supervisor.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await supervisor.start(); const initial = supervisor.current();
  const api = (route, options) => fetch(`http://127.0.0.1:${publicPort}${route}`, options);
  const request = () => api("/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "diagnose" }) });
  const diagnose = async () => {
    trigger = true; assert.equal((await api("/api/diagnostics/413/arm", { method: "POST" })).status, 200);
    const response = await request(); assert.equal(response.status, 413); await response.text(); await until(() => release);
  };
  const records = async () => { try { return (await readFile(path.join(data, "413-diagnostics.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
  await diagnose();
  await assert.rejects(supervisor.upgrade(fallback), /未确认 handoff_prepare_readonly/);
  assert.equal(supervisor.current(), initial); assert.equal(supervisor.state().phase, "active");
  release(); await until(async () => (await records()).length === 1);
  await until(async () => !(await api("/api/diagnostics/413").then((r) => r.json())).running);
  await pause(50);
  assert.equal((await api("/api/status").then((r) => r.json())).handoff.readOnly, false, "迟到准备不能再次把恢复的工作进程变成只读");
  const response = await request(); assert.equal(response.status, 200); await response.text();
  await supervisor.upgrade(fallback); assert.equal(supervisor.current().id, "background-b");
  await diagnose();
  let stopped = false; const stopping = supervisor.close().then(() => { stopped = true; });
  await pause(50); assert.equal(stopped, false, "已返回 413 的请求仍有后台诊断，不能提前退出");
  release(); await stopping;
  const logged = await records(); assert.equal(logged.length, 2); assert.ok(logged.every((record) => record.steps.length === 4));
  assert.equal(calls, 11); assert.ok(events.some((line) => line.includes('"restored":true')));
  t.diagnostic(JSON.stringify({ diagnosticRecords: logged.length, upstreamCalls: calls, latePrepareCancelled: true, gracefulDiagnosticFlush: true }));
});
