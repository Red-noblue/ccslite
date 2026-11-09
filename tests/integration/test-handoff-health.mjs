/**
 * 中文固定监听健康观察演练：候选卡住只告警，保留回退进程与已有流；连续恢复后才结束观察。
 * 仅暂停本测试创建的工作进程，使用独立数据、端口及假上游，不进行真实供应商探测。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error("等待固定监听健康观察超时");
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; assert.ok(port >= 15725); return port;
}

test("健康异常保留回退进程和 SSE，恢复后连续观察才能归档", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-health-"));
  const data = path.join(root, "data"); await mkdir(data);
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "observed-candidate"); await createReleaseSnapshot(ROOT, fallback, "observed-fallback");
  let calls = 0; let finish = () => {}; let supervisor; let paused = null;
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); calls += 1;
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.stream) {
      const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(event("response.output_text.delta", { delta: "开始" }));
      const timer = setInterval(() => res.write(event("response.output_text.delta", { delta: "继续" })), 50);
      res.once("close", () => clearInterval(timer));
      finish = () => { clearInterval(timer); if (!res.destroyed) res.end(event("response.completed", { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })); };
    } else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}'); }
  });
  t.after(async () => {
    if (paused) paused.child.kill("SIGCONT"); finish();
    await supervisor?.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const upstreamPort = await listen(upstream); const guard = createServer(); const publicPort = await listen(guard);
  await new Promise((resolve) => guard.close(resolve));
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }],
    connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const events = [];
  supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort,
    observeMs: 500, healthPolicy: { intervalMs: 50, timeoutMs: 100, failureThreshold: 3 }, log: (line) => events.push(JSON.parse(line)) });
  await supervisor.start();
  const old = supervisor.current(); await supervisor.upgrade(fallback);
  const current = supervisor.current();
  const response = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake", input: "hold", stream: true }) });
  const text = response.text();
  paused = current; current.child.kill("SIGSTOP");
  await until(() => events.some((event) => event.event === "health_degraded" && event.pid === current.pid));
  await pause(600);
  assert.equal(supervisor.state().previous, old.id, "候选异常时不能因观察时间已过而丢弃回退进程");
  assert.equal(old.child.exitCode, null); assert.equal(old.child.signalCode, null);
  assert.equal(supervisor.current().pid, current.pid); assert.equal(calls, 1, "只读健康观察不能调用上游");
  assert.ok(!events.some((event) => event.event === "handoff_rollback_started"), "仅卡住不应强制回退或中断流");
  assert.ok(supervisor.state().health.lastError);
  current.child.kill("SIGCONT"); paused = null;
  await until(() => events.some((event) => event.event === "health_recovered" && event.pid === current.pid));
  assert.equal(supervisor.state().previous, old.id, "单次恢复不足以结束观察");
  finish(); assert.match(await text, /response.completed/);
  await until(() => supervisor.state().previous === null);
  await old.exit;
  await until(() => events.some((event) => event.event === "handoff_previous_retired"));
  const retirement = events.findIndex((event) => event.event === "handoff_previous_retired");
  const recovery = events.findIndex((event) => event.event === "health_recovered" && event.pid === current.pid);
  assert.ok(retirement > recovery);
  assert.ok(supervisor.state().health.consecutiveSuccesses >= 3);
  await until(async () => (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).length === 1);
  assert.equal(calls, 1);
  t.diagnostic(JSON.stringify({ degradedAction: "observe_only", oldWorkerRetainedWhileUnhealthy: true, sseCompleted: true, upstreamCalls: calls, retiredAfterContinuousRecovery: true }));
});
