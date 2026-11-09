/**
 * 中文在线命令验收：通过真实命令行入口升级和回退，公开主/分组端口与已有 SSE 保持工作。
 * 本机假上游及版本包、日志和数据均为本测试自有，绝不操作正式服务。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";
import { createHandoffControl, requestHandoffControl } from "../../lib/handoff-control.js";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; assert.ok(port >= 15725); return port;
}
async function reserve() { const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }
async function until(check) {
  for (let i = 0; i < 600; i += 1) { const value = await check(); if (value) return value; await pause(20); }
  throw new Error("等待在线命令状态超时");
}
function launch(args) {
  const child = spawn(process.execPath, [path.join(ROOT, "handoff-runner.mjs"), ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}

test("在线命令保留监听和长 SSE，能够查询、升级并回退", { timeout: 45000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-control-"));
  const data = path.join(root, "验证中文路径与很长的数据目录名称不会超过系统套接字路径上限".repeat(2)); await mkdir(data);
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "control-a"); await createReleaseSnapshot(ROOT, fallback, "control-b");
  const next = path.join(root, "next"); await createReleaseSnapshot(ROOT, next, "control-c");
  let calls = 0; let release = () => {};
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); calls += 1;
    if (body.input === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"开始"}\n\n');
      release = () => res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n'); return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const upstreamPort = await listen(upstream); const publicPort = await reserve(); const qualityPort = await reserve();
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] },
      { id: "quality", name: "质量", listener: { host: "127.0.0.1", port: qualityPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const runner = launch(["--candidate", candidate, "--fallback", fallback, "--data-dir", data, "--port", String(publicPort), "--observe-ms", "30000"]);
  t.after(async () => { release(); if (runner.child.exitCode === null) runner.child.kill("SIGTERM"); await runner.exit; upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const ready = await until(() => runner.stdout().split("\n").find((line) => line.startsWith('{"event":"ready"')));
  const socketPath = JSON.parse(ready).control; assert.equal((await lstat(socketPath)).mode & 0o777, 0o600); assert.ok(Buffer.byteLength(socketPath) <= 100);
  const command = (action, extra = []) => launch([action, "--data-dir", data, ...extra]).exit;
  const state = async () => { const result = await command("status"); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout).state; };
  const request = (port, input) => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input, stream: input === "hold" }) });
  const first = await request(publicPort, "initial"); assert.equal(first.status, 200); await first.text();
  const stream = await request(publicPort, "hold"); const streamText = stream.text();
  const upgrading = command("upgrade", ["--candidate", next]);
  await until(async () => (await state()).phase === "draining");
  const competing = await command("upgrade", ["--candidate", candidate]); assert.equal(competing.code, 2); assert.match(competing.stderr, /交接正在进行/);
  const queued = request(publicPort, "queued");
  await until(async () => { const current = await state(); return current.phase === "draining" && current.current === "control-a"; });
  release(); assert.match(await streamText, /response.completed/);
  const upgraded = await upgrading; assert.equal(upgraded.code, 0, upgraded.stderr); assert.equal(JSON.parse(upgraded.stdout).worker, "control-c");
  const afterQueue = await queued; assert.equal(afterQueue.status, 200); await afterQueue.text();
  const quality = await request(qualityPort, "quality"); assert.equal(quality.status, 200); await quality.text();
  const rolledBack = await command("rollback"); assert.equal(rolledBack.code, 0, rolledBack.stderr); assert.equal((await state()).current, "control-b");
  const recovered = await request(qualityPort, "restored"); assert.equal(recovered.status, 200); await recovered.text();
  runner.child.kill("SIGTERM"); const stopped = await runner.exit; assert.equal(stopped.code, 0, stopped.stderr); assert.match(stopped.stdout, /"event":"stopped"/);
  const lines = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean);
  assert.equal(calls, 5); assert.equal(lines.length, 5); assert.ok(lines.every((line) => JSON.parse(line).statusCode === 200));
  const journal = (await readFile(path.join(data, "handoff-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.doesNotMatch(stopped.stdout, /handoff_request_finished/, "常规转发不应刷终端日志");
  assert.equal(journal.filter((entry) => entry.event === "handoff_request_finished").length, 0, "文件日志不应逐请求保存完成事件");
  assert.ok(journal.filter((entry) => entry.event === "handoff_request_summary").reduce((total, entry) => total + entry.completedRequests, 0) >= 5, "文件日志应保存全部请求完成汇总");
  assert.ok(journal.every((entry) => entry.timestamp && entry.supervisorPid === runner.child.pid));
  for (const event of ["handoff_activated", "handoff_recovery_completed", "handoff_closed"]) assert.ok(journal.some((entry) => entry.event === event), event);
  assert.equal((await lstat(path.join(data, "handoff-events.jsonl"))).mode & 0o777, 0o600);
  await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ upstreamCalls: calls, usageRecords: lines.length, onlineUpgrade: true, onlineRollback: true, longSsePreserved: true, controlMode: "0600" }));
});

test("upgrade-session 命令按会话逐步交接并保留旧会话请求", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-session-control-"));
  const data = path.join(root, "data"); await mkdir(data);
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "session-control-old"); await createReleaseSnapshot(ROOT, fallback, "session-control-new");
  let release = () => {};
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (payload.input === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"开始"}\n\n');
      release = () => { if (!res.destroyed) res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n'); };
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const upstreamPort = await listen(upstream); const publicPort = await reserve();
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const runner = launch(["--candidate", candidate, "--fallback", fallback, "--data-dir", data, "--port", String(publicPort), "--observe-ms", "30000"]);
  t.after(async () => { release(); if (runner.child.exitCode === null) runner.child.kill("SIGTERM"); await runner.exit; upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await until(() => runner.stdout().split("\n").find((line) => line.startsWith('{"event":"ready"')));
  const command = (action, extra = []) => launch([action, "--data-dir", data, ...extra]).exit;
  const state = async () => { const result = await command("status"); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout).state; };
  const request = (session, input) => fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": session }, body: JSON.stringify({ model: "fake", input, stream: input === "hold" }) });

  const hold = await request("A", "hold"); assert.equal(hold.status, 200); const holdText = hold.text();
  const upgrading = await command("upgrade-session", ["--candidate", fallback]);
  assert.equal(upgrading.code, 0, upgrading.stderr); assert.equal(JSON.parse(upgrading.stdout).worker, "session-control-new");
  await until(async () => (await state()).phase === "active_parallel");
  const newSession = await request("B", "new"); assert.equal(newSession.status, 200); await newSession.text();
  const oldConcurrent = await request("A", "old-concurrent"); assert.equal(oldConcurrent.status, 200); await oldConcurrent.text();
  release(); assert.match(await holdText, /response.completed/);
  await until(async () => (await state()).session?.legacySessionCount === 0);
  const migrated = await request("A", "after"); assert.equal(migrated.status, 200); await migrated.text();
  const records = await until(async () => {
    const lines = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean);
    return lines.length === 4 ? lines.map(JSON.parse) : false;
  });
  assert.equal(records.length, 4);
  assert.ok(records.some((record) => String(record.handoffWorkerId || "").startsWith("session-control-old:")));
  assert.ok(records.some((record) => String(record.handoffWorkerId || "").startsWith("session-control-new:")));
  t.diagnostic(JSON.stringify({ command: "upgrade-session", records: records.length, oldSessionCompleted: true, newSessionStartedOnCandidate: true, migratedSessionContinued: true }));
});

test("会话旧版本退役后，控制命令可以再次升级", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-session-reupgrade-"));
  const data = path.join(root, "data"); await mkdir(data);
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "session-reupgrade-old"); await createReleaseSnapshot(ROOT, fallback, "session-reupgrade-new");
  let release = () => {};
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (payload.input === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"开始"}\n\n');
      release = () => { if (!res.destroyed) res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n'); };
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const upstreamPort = await listen(upstream); const publicPort = await reserve();
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  let supervisor; let control;
  t.after(async () => {
    release(); await control?.close(); await supervisor?.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true });
  });
  supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, observeMs: 0,
    healthPolicy: { intervalMs: 20, timeoutMs: 100, failureThreshold: 2 }, log: () => {} });
  await supervisor.start(); control = await createHandoffControl({ dataDir: data, supervisor });
  const request = (input) => fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": "reupgrade-session" }, body: JSON.stringify({ model: "fake", input, stream: input === "hold" }) });

  const held = await request("hold"); assert.equal(held.status, 200); const heldText = held.text();
  const first = await requestHandoffControl(data, { action: "upgrade-session", candidate: fallback });
  assert.equal(first.ok, true); assert.equal(first.worker, "session-reupgrade-new");
  await until(() => supervisor.state().phase === "active_parallel");
  release(); assert.match(await heldText, /response.completed/);
  await until(() => supervisor.state().phase === "active" && supervisor.state().previous === null && supervisor.state().session?.legacySessionCount === 0, 20_000);

  const second = await requestHandoffControl(data, { action: "upgrade-session", candidate });
  assert.equal(second.ok, true); assert.equal(second.worker, "session-reupgrade-old");
  assert.equal(supervisor.state().phase, "active_parallel");
  t.diagnostic(JSON.stringify({ firstUpgrade: first.worker, retiredPhase: "active", secondUpgrade: second.worker, controlSocket: true }));
});
