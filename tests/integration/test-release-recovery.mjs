/**
 * 版本升级与回退演练：只用临时副本和本机上游，验证失败回退、用量保留及端口保护。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "lite-release-recovery-"));
  const source = path.join(root, "source");
  await mkdir(source);
  // 只复制实际运行需要的独立依赖，测试不借用正在使用项目的 node_modules。
  for (const entry of ["server.js", "lib", "public", "package.json", "package-lock.json", "restart.sh"]) await cp(path.join(ROOT, entry), path.join(source, entry), { recursive: true });
  await mkdir(path.join(source, "node_modules"));
  await cp(path.join(ROOT, "node_modules/undici"), path.join(source, "node_modules/undici"), { recursive: true });
  const stable = path.join(root, "stable");
  await createReleaseSnapshot(source, stable, "stable-tested");
  const dataDir = path.join(root, "data");
  await mkdir(dataDir);
  let finishStream = () => {};
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (JSON.parse(Buffer.concat(chunks).toString()).stream) {
      res.setHeader("content-type", "text/event-stream");
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n');
      finishStream = () => res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "local-test", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }));
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const config = { version: 2, proxy: { autoFailoverEnabled: false, currentProviderId: "local" },
    providers: [{ id: "local", name: "本机测试", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "fake" }],
    groups: [{ id: "default", routingVersion: 1, name: "测试", listener: { host: "127.0.0.1", port, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }],
    connectivityTest: { periodicIntervalMs: 86400000 },
  };
  await writeFile(path.join(dataDir, "config.json"), JSON.stringify(config));
  await writeFile(path.join(dataDir, "usage.jsonl"), JSON.stringify({ id: "history", timestamp: new Date().toISOString(), statusCode: 200, totalTokens: 11 }) + "\n");
  const children = [];
  t.after(async () => {
    finishStream();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, stable, dataDir, port, config, children, finishStream: () => finishStream() };
}
function start(f, candidate, overrides = {}, fallback = f.stable, startupTimeoutMs = 3000) {
  let logs = "";
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  const child = spawn(process.execPath, [path.join(ROOT, "release.mjs"), "run", candidate,
    "--fallback", fallback, "--data-dir", f.dataDir, "--port", String(f.port), "--startup-timeout-ms", String(startupTimeoutMs)],
  { cwd: f.root, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => { logs += data; });
  child.stderr.on("data", (data) => { logs += data; });
  f.children.push(child);
  return { child, logs: () => logs };
}
async function status(f, service, releaseId) {
  for (let n = 0; n < 150; n += 1) {
    if (service.child.exitCode !== null) throw new Error(service.logs());
    try {
      const response = await fetch(`http://127.0.0.1:${f.port}/api/status`, { signal: AbortSignal.timeout(300) });
      const body = await response.json();
      if (body.build?.releaseId === releaseId && service.logs().includes(`"event":"ready"`)) return body;
    } catch { /* 等待版本启动或自动回退。 */ }
    await pause(30);
  }
  throw new Error(`版本未就绪：${service.logs()}`);
}
async function request(f) {
  const response = await fetch(`http://127.0.0.1:${f.port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "local-test", input: "test" }) });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
}

test("候选启动失败自动回退，恢复配置且保留失败期间新增的用量", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "server.js"), `// 中文故障注入：模拟启动时修改配置并失败。\nimport fs from 'node:fs';
fs.writeFileSync(process.env.LITE_CCSWITCH_CONFIG, JSON.stringify({version:2,broken:true}));
fs.appendFileSync(process.env.LITE_CCSWITCH_USAGE, '\\n'+JSON.stringify({id:'candidate-history',statusCode:500})+'\\n');
process.exit(1);\n`);
  const candidate = path.join(f.root, "broken");
  await createReleaseSnapshot(f.source, candidate, "broken-candidate");
  const service = start(f, candidate, { LITE_CCSWITCH_USAGE: "/must-not-be-used/production.jsonl" });
  const restored = await status(f, service, "stable-tested");
  assert.equal(restored.totalRequests, 2);
  assert.equal(restored.persistence.usagePath, await realpath(path.join(f.dataDir, "usage.jsonl")));
  assert.match(service.logs(), /"event":"rollback"/);
  const config = JSON.parse(await readFile(path.join(f.dataDir, "config.json"), "utf8"));
  assert.equal(config.broken, undefined);
  assert.equal(config.proxy.currentProviderId, "local");
  await request(f);
  const exited = once(service.child, "exit");
  service.child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
  const records = (await readFile(path.join(f.dataDir, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(records.length, 3);
  assert.ok(records.some((record) => record.id === "history"));
  assert.ok(records.some((record) => record.id === "candidate-history"));
});

test("候选就绪后可请求，正常退出不触发回退，旧版本可继续读取新增历史", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const candidate = path.join(f.root, "candidate");
  await createReleaseSnapshot(f.source, candidate, "next-tested");
  const first = start(f, candidate);
  const initial = await status(f, first, "next-tested");
  assert.equal(initial.totalRequests, 1);
  await request(f);
  const exited = once(first.child, "exit");
  first.child.kill("SIGTERM");
  await exited;
  assert.doesNotMatch(first.logs(), /"event":"rollback"/);
  const second = start(f, f.stable, {}, candidate);
  const next = await status(f, second, "stable-tested");
  assert.equal(next.totalRequests, 2);
  assert.notEqual(next.processId, initial.processId);
  await request(f);
});

test("端口已占用或版本包被修改时拒绝启动，已有服务保持可用", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const candidate = path.join(f.root, "candidate");
  await createReleaseSnapshot(f.source, candidate, "next-tested");
  const running = start(f, candidate);
  const before = await status(f, running, "next-tested");
  const denied = start(f, candidate);
  assert.equal((await once(denied.child, "exit"))[0], 1);
  assert.match(denied.logs(), /已占用/);
  assert.equal((await status(f, running, "next-tested")).processId, before.processId);
  await writeFile(path.join(candidate, "public/index.html"), "tampered");
  const tampered = start(f, candidate);
  assert.equal((await once(tampered.child, "exit"))[0], 1);
  assert.match(tampered.logs(), /校验失败/);
  assert.equal((await status(f, running, "next-tested")).processId, before.processId);
  await request(f);
});

test("候选意外退出后回退一次，保留就绪后修改的配置与用量", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const candidate = path.join(f.root, "candidate");
  await createReleaseSnapshot(f.source, candidate, "next-tested");
  const service = start(f, candidate);
  const running = await status(f, service, "next-tested");
  const changed = await fetch(`http://127.0.0.1:${f.port}/api/config`, { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ ui: { palette: "forest" } }) });
  assert.equal(changed.status, 200);
  await request(f);
  // 崩溃演练验证已落盘历史；已送达但尚未落盘的在途记录不属于回退可恢复范围。
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const records = (await readFile(path.join(f.dataDir, "usage.jsonl"), "utf8")).split("\n").filter(Boolean);
    if (records.length === 2) break;
    await pause(20);
  }
  assert.equal((await readFile(path.join(f.dataDir, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).length, 2);
  // 只终止测试启动器自己创建的子进程，模拟无法优雅处理的进程崩溃。
  process.kill(running.processId, "SIGKILL");
  const restored = await status(f, service, "stable-tested");
  assert.equal(restored.totalRequests, 2);
  assert.equal(restored.ui.palette, "forest");
  assert.match(service.logs(), /"configRestored":false/);
  await request(f);
});

test("正常停止等待现有 SSE 完成，不触发回退也不强制断开", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const candidate = path.join(f.root, "candidate");
  await createReleaseSnapshot(f.source, candidate, "next-tested");
  const service = start(f, candidate);
  await status(f, service, "next-tested");
  const response = await fetch(`http://127.0.0.1:${f.port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "local-test", input: "test", stream: true }) });
  const body = response.text();
  const exited = once(service.child, "exit");
  service.child.kill("SIGTERM");
  await pause(150);
  assert.equal(service.child.exitCode, null);
  f.finishStream();
  assert.match(await body, /response.completed/);
  assert.equal((await exited)[0], 0);
  assert.doesNotMatch(service.logs(), /"event":"rollback"/);
});

test("旧重启入口识别版本监督器，保留活动 SSE 且不触发意外回退", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const candidate = path.join(f.root, "candidate");
  await createReleaseSnapshot(f.source, candidate, "next-tested");
  const service = start(f, candidate);
  const before = await status(f, service, "next-tested");
  const response = await fetch(`http://127.0.0.1:${f.port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "local-test", input: "test", stream: true }) });
  const body = response.text();
  let logs = "";
  const restart = spawn("bash", [path.join(candidate, "restart.sh"), String(f.port)], {
    env: { ...process.env, LITE_CCSWITCH_NODE: process.execPath, LITE_CCSWITCH_DATA_DIR: f.dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  restart.stdout.on("data", (value) => { logs += value; });
  restart.stderr.on("data", (value) => { logs += value; });
  assert.equal((await once(restart, "exit"))[0], 1);
  assert.match(logs, /由版本监督器/);
  assert.equal((await status(f, service, "next-tested")).processId, before.processId);
  assert.doesNotMatch(service.logs(), /"event":"rollback"/);
  f.finishStream();
  assert.match(await body, /response.completed/);
  await request(f);
});

test("两个版本都启动失败时停止，不无限重试或覆盖历史", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "server.js"), "// 中文故障注入：立即退出。\nprocess.exit(1);\n");
  const candidate = path.join(f.root, "broken");
  const fallback = path.join(f.root, "also-broken");
  await createReleaseSnapshot(f.source, candidate, "broken-1");
  await createReleaseSnapshot(f.source, fallback, "broken-2");
  const historyBefore = await readFile(path.join(f.dataDir, "usage.jsonl"), "utf8");
  const service = start(f, candidate, {}, fallback);
  assert.equal((await once(service.child, "exit"))[0], 1);
  assert.equal(service.logs().split('"event":"starting"').length - 1, 2);
  assert.equal(service.logs().split('"event":"rollback"').length - 1, 1);
  assert.equal(await readFile(path.join(f.dataDir, "usage.jsonl"), "utf8"), historyBefore);
});

test("未就绪候选忽略 SIGTERM 时有界清理并回退，正式停止规则不变", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "server.js"), `// 中文故障注入：模拟永不就绪且拒绝停止的候选。\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`);
  const candidate = path.join(f.root, "unresponsive");
  await createReleaseSnapshot(f.source, candidate, "unresponsive-candidate");
  // 此处验证拒绝停止的候选会被清理，不把真实回退服务能否在 200ms 内冷启动作为前提。
  const service = start(f, candidate, {}, f.stable, 1000);
  for (let n = 0; n < 300 && !service.logs().includes('"event":"startup_force_stop"'); n += 1) await pause(20);
  assert.match(service.logs(), /"event":"startup_force_stop"/);
  await status(f, service, "stable-tested");
  assert.match(service.logs(), /"event":"rollback"/);
  await request(f);
});

test("启动中主动停止只发送一次 SIGTERM，不误触发二次强制断开", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "server.js"), `// 中文故障注入：记录启动阶段收到的停止次数。\nimport fs from 'node:fs';
let signals=0;process.on('SIGTERM',()=>{fs.writeFileSync(process.env.LITE_CCSWITCH_DATA_DIR+'/signals',String(++signals));setTimeout(()=>process.exit(0),150);});
fs.writeFileSync(process.env.LITE_CCSWITCH_DATA_DIR+'/signal-ready','ready');setInterval(()=>{},1000);\n`);
  const candidate = path.join(f.root, "slow-start");
  await createReleaseSnapshot(f.source, candidate, "slow-start");
  const service = start(f, candidate);
  for (let n = 0; n < 100; n += 1) {
    if (await readFile(path.join(f.dataDir, "signal-ready"), "utf8").catch(() => "")) break;
    await pause(20);
  }
  assert.equal(await readFile(path.join(f.dataDir, "signal-ready"), "utf8"), "ready");
  const exit = once(service.child, "exit");
  service.child.kill("SIGTERM");
  assert.equal((await exit)[0], 0);
  assert.equal(await readFile(path.join(f.dataDir, "signals"), "utf8"), "1");
  assert.doesNotMatch(service.logs(), /"event":"rollback"|"event":"startup_force_stop"/);
});

test("监督器意外退出时现有 SSE 完整排空，子进程退出后可恢复监督与历史", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const candidate = path.join(f.root, "candidate");
  await createReleaseSnapshot(f.source, candidate, "next-tested");
  const service = start(f, candidate);
  const initial = await status(f, service, "next-tested");
  const response = await fetch(`http://127.0.0.1:${f.port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "local-test", input: "test", stream: true }) });
  const body = response.text();
  const exit = once(service.child, "exit");
  service.child.kill("SIGKILL");
  await exit;
  // IPC 断开后只排空，不强断仍在等待上游的请求。
  await pause(150);
  process.kill(initial.processId, 0);
  f.finishStream();
  assert.match(await body, /response.completed/);
  let gone = false;
  for (let n = 0; n < 100; n += 1) {
    try { process.kill(initial.processId, 0); }
    catch (error) { if (error.code === "ESRCH") { gone = true; break; } throw error; }
    await pause(20);
  }
  assert.ok(gone, "监督器退出后，子进程应在 SSE 完成并落盘后退出");
  const recovered = start(f, candidate);
  assert.equal((await status(f, recovered, "next-tested")).totalRequests, 2);
  const archives = await readdir(path.join(f.dataDir, "release-recovery"));
  assert.ok(archives.some((name) => name.startsWith("abandoned-lock-")));
  await request(f);
});
