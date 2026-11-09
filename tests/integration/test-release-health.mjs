/**
 * 就绪后的监督器健康观察：使用独立代码、依赖、数据和端口，只暂停自建子进程。
 * 验证卡住告警与恢复、告警后崩溃回退、正常排空不误报，以及观察不产生上游计费。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error("等待监督器健康观察状态超时");
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  assert.ok(server.address().port >= 15725); return server.address().port;
}
async function reserve() {
  const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "lite-release-health-")); const source = path.join(root, "source"); await mkdir(source);
  for (const name of ["server.js", "lib", "public", "package.json", "package-lock.json"])
    await cp(path.join(ROOT, name), path.join(source, name), { recursive: true });
  await mkdir(path.join(source, "node_modules")); await cp(path.join(ROOT, "node_modules/undici"), path.join(source, "node_modules/undici"), { recursive: true });
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(source, candidate, "health-candidate"); await createReleaseSnapshot(source, fallback, "health-fallback");
  let calls = 0; let finish = () => {}; let passed = false;
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); calls += 1;
    if (JSON.parse(Buffer.concat(chunks).toString()).stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n');
      finish = () => { if (!res.writableEnded) res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'); };
    } else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}'); }
  });
  const upstreamPort = await listen(upstream); const port = await reserve(); const groupPort = await reserve();
  const data = path.join(root, "data"); await mkdir(data);
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2,
    proxy: { autoFailoverEnabled: false, currentProviderId: "local", streamingIdleTimeoutMs: 60000 },
    providers: [{ id: "local", name: "本机伪上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [["default", port], ["quality", groupPort]].map(([id, p]) => ({ id, name: id, routingVersion: 1,
      listener: { host: "127.0.0.1", port: p, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] })),
    connectivityTest: { periodicIntervalMs: null } }));
  let stdout = ""; let stderr = ""; let pending = ""; const events = []; const owned = new Set(); const paused = new Set();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_") && !["NODE_PATH", "NODE_OPTIONS"].includes(key)));
  const parent = spawn(process.execPath, [path.join(ROOT, "release.mjs"), "run", candidate, "--fallback", fallback,
    "--data-dir", data, "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise((resolve, reject) => { parent.once("close", (code, signal) => resolve({ code, signal })); parent.once("error", reject); });
  parent.stdout.on("data", (chunk) => {
    stdout += chunk; pending += chunk; const lines = pending.split("\n"); pending = lines.pop();
    for (const line of lines) { try { const e = JSON.parse(line); events.push(e); if (e.event === "starting") owned.add(e.pid); } catch {} }
  }); parent.stderr.on("data", (chunk) => { stderr += chunk; });
  const signal = (pid, name) => { assert.ok(owned.has(pid)); process.kill(pid, name); if (name === "SIGSTOP") paused.add(pid); else if (["SIGCONT", "SIGKILL"].includes(name)) paused.delete(pid); };
  t.after(async () => {
    for (const pid of paused) signal(pid, "SIGCONT"); finish();
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGTERM"); const timer = setTimeout(() => { for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch {} } parent.kill("SIGKILL"); }, 3000);
      try { await exit; } finally { clearTimeout(timer); }
    }
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    // 失败时保留独立日志与数据，成功时清理自己创建的临时产物。
    if (!passed) {
      await writeFile(path.join(root, "supervisor.stdout.log"), stdout); await writeFile(path.join(root, "supervisor.stderr.log"), stderr);
    } else await rm(root, { recursive: true, force: true });
  });
  const event = (name, releaseId) => events.find((e) => e.event === name && (!releaseId || e.releaseId === releaseId));
  const started = await until(() => {
    if (parent.exitCode !== null) throw new Error(stdout + stderr); return event("ready", "health-candidate");
  });
  t.diagnostic(JSON.stringify({ root, port, groupPort, supervisorPid: parent.pid, childPid: started.pid }));
  const request = async (stream = false, target = port) => {
    const response = await fetch(`http://127.0.0.1:${target}/v1/responses`, { method: "POST", signal: AbortSignal.timeout(60000),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "health-test", input: "local", stream }) });
    assert.equal(response.status, 200); return response;
  };
  return { root, data, port, groupPort, parent, exit, started, events, event, signal, request, finish: () => finish(), calls: () => calls,
    passed: () => { passed = true; } };
}

test("就绪后启动持续观察，等待期间没有供应商调用", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const observed = await until(() => f.event("health_monitor_started"), 1000);
  assert.equal(observed.pid, f.started.pid); assert.equal(observed.intervalMs, 5000); assert.equal(observed.timeoutMs, 1000); assert.equal(observed.failureThreshold, 3);
  const recovery = path.join(f.data, "release-recovery");
  const file = (await readdir(recovery)).find((name) => name.endsWith(".json") && !name.endsWith(".config.json"));
  const history = JSON.parse(await readFile(path.join(recovery, file), "utf8"));
  assert.ok(history.events.some((e) => e.event === "health_monitor_started" && e.pid === f.started.pid));
  assert.equal(f.calls(), 0);
  f.passed();
});

test("活动 SSE 期间子进程卡住仅告警，恢复原进程后原流仍完整", { timeout: 40000 }, async (t) => {
  const f = await fixture(t); await until(() => f.event("health_monitor_started"));
  const response = await f.request(true); const text = response.text();
  f.signal(f.started.pid, "SIGSTOP");
  const degraded = await until(() => f.event("health_degraded"), 21000);
  assert.equal(degraded.pid, f.started.pid); assert.equal(degraded.consecutiveFailures, 3); assert.equal(degraded.action, "observe_only");
  assert.equal(f.parent.exitCode, null); assert.equal(f.events.filter((e) => e.event === "starting").length, 1);
  assert.ok(!f.event("rollback")); assert.equal(f.calls(), 1);
  f.signal(f.started.pid, "SIGCONT"); const recovered = await until(() => f.event("health_recovered"), 7000);
  assert.equal(recovered.pid, f.started.pid);
  f.finish(); assert.match(await text, /response.completed/);
  await (await f.request(false, f.groupPort)).text(); assert.equal(f.calls(), 2);
  t.diagnostic(JSON.stringify({ degraded, recovered, streamCompleted: true }));
  f.passed();
});

test("连续失败告警后子进程崩溃，仍只回退一次并观察新进程", { timeout: 40000 }, async (t) => {
  const f = await fixture(t); await until(() => f.event("health_monitor_started"));
  f.signal(f.started.pid, "SIGSTOP"); await until(() => f.event("health_degraded"), 21000);
  f.signal(f.started.pid, "SIGKILL");
  const fallback = await until(() => f.event("ready", "health-fallback"));
  await until(() => f.event("health_monitor_started", "health-fallback"));
  assert.notEqual(fallback.pid, f.started.pid); assert.equal(f.events.filter((e) => e.event === "rollback").length, 1);
  assert.ok(!f.event("health_recovered", "health-candidate")); await (await f.request()).text();
  f.passed();
});

test("正常排空超过三轮检测仍不告警，活动 SSE 完成后正常退出", { timeout: 26000 }, async (t) => {
  const f = await fixture(t); await until(() => f.event("health_monitor_started"));
  const response = await f.request(true); const text = response.text(); f.parent.kill("SIGTERM");
  await pause(17000); assert.equal(f.parent.exitCode, null);
  assert.ok(!f.event("health_degraded")); assert.ok(!f.event("rollback"));
  f.finish(); assert.match(await text, /response.completed/); assert.equal((await f.exit).code, 0);
  f.passed();
});
