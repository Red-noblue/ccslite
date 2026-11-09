#!/usr/bin/env node
/**
 * 实际 Codex CLI 隔离验收：自动复制 Lite 代码与依赖、便携入口，生成假的 cct 配置。
 * 只访问本机伪供应商；按结构化完成事件、工具副作用与取消后的请求数量判定结果。
 * 所有信号只发送给本脚本创建并保存的进程，不接管既有端口或读取真实认证配置。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const help = `用法：node tests/manual/test-codex-isolated.mjs
  --codex-portable <便携工具目录> --codex-bin <codex.js>
  [--output-dir <已存在的结果父目录>] [--scenario all|tools|cancel|cancel-tui|restart]
自动创建独立代码、依赖、数据、cct profile、会话与工作目录，使用随机本机端口。
不读取现有 profile 或 OAuth，不调用真实供应商。restart 仅强制中断自建测试实例。
完整 CC Switch 链路不在本脚本的验收范围内。`;
const options = {};
const args = process.argv.slice(2);
for (let n = 0; n < args.length; n += 2) {
  if (["--help", "-h"].includes(args[n])) { console.log(help); process.exit(0); }
  if (!["--codex-portable", "--codex-bin", "--output-dir", "--scenario"].includes(args[n]) || !args[n + 1] || options[args[n]]) {
    throw new Error(`未知、缺失或重复参数：${args[n]}\n${help}`);
  }
  options[args[n]] = args[n + 1];
}
if (!options["--codex-portable"] || !options["--codex-bin"]) throw new Error(help);
const selected = options["--scenario"] || "all";
assert.ok(["all", "tools", "cancel", "cancel-tui", "restart"].includes(selected), "不支持的测试场景");
const portableEntry = path.resolve(options["--codex-portable"], "bin/codex-project");
const codexBin = path.resolve(options["--codex-bin"]);
await readFile(portableEntry); await readFile(codexBin);
const root = await mkdtemp(path.join(path.resolve(options["--output-dir"] || tmpdir()), "lite-codex-cli-"));
console.log(`隔离验收目录：${root}`);
const code = path.join(root, "lite");
const manifest = await createReleaseSnapshot(SOURCE, code, `cli-test-${Date.now()}`);
const portable = path.join(root, "portable");
await mkdir(path.join(portable, "bin"), { recursive: true });
await copyFile(portableEntry, path.join(portable, "bin/codex-project"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await pause(25); }
  throw new Error("等待隔离测试状态超时");
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  assert.ok(port >= 15725, "隔离测试端口必须不低于 15725");
  return port;
}
const event = (type, values = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...values })}\n\n`;
const responseObject = (id, output = [], status = "completed") => ({ id, object: "response", status,
  model: "gpt-6.1-sol", output, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
function prelude(res, id) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(event("response.created", { response: responseObject(id, [], "in_progress") }));
}
function textResponse(res, text, id = "resp_success") {
  prelude(res, id);
  const item = { type: "message", id: `${id}_message`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
  res.write(event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }));
  res.write(event("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: text }));
  res.write(event("response.output_text.done", { output_index: 0, content_index: 0, item_id: item.id, text }));
  res.write(event("response.output_item.done", { output_index: 0, item }));
  res.end(event("response.completed", { response: responseObject(id, [item]) }));
}
function groupSignal(child, signal) {
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
function tracked(command, argv, config) {
  const child = spawn(command, argv, { ...config, detached: true, stdio: config.stdio || ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}
async function stop(process, signal = "SIGTERM") {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return process.exit;
  groupSignal(process.child, signal);
  const timer = setTimeout(() => groupSignal(process.child, "SIGKILL"), 2000);
  try { return await process.exit; } finally { clearTimeout(timer); }
}
function cleanEnvironment() {
  const allowed = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "SystemRoot"];
  return Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}
async function fixture(name, handlers) {
  const dir = path.join(root, name); const data = path.join(dir, "data"); const workspace = path.join(dir, "workspace");
  const state = path.join(dir, "codex-state"); const profile = path.join(state, "configs/cct");
  for (const p of [data, workspace, profile]) await mkdir(p, { recursive: true });
  const calls = handlers.map(() => []); const auxiliaryCalls = []; const upstreams = [];
  for (const [index, handler] of handlers.entries()) {
    const server = createServer(async (req, res) => {
      if (req.method !== "POST" || !/\/responses$/.test(req.url)) { res.writeHead(404); res.end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      // TUI 会额外请求会话标题；独立记录并正常响应，不将其误计为取消后的重试。
      let metadata = {};
      try { metadata = JSON.parse(body.client_metadata?.["x-codex-turn-metadata"] || "{}"); } catch {}
      if (metadata.thread_source === "thread_title") {
        auxiliaryCalls.push({ at: Date.now(), provider: index, body });
        textResponse(res, "隔离验收", `resp_title_${auxiliaryCalls.length}`);
        return;
      }
      calls[index].push({ at: Date.now(), body });
      try { handler(req, res, body, calls[index].length); }
      catch (error) { res.destroy(error); calls[index].at(-1).handlerError = error.stack; }
    });
    upstreams.push({ server, port: await listen(server) });
  }
  const reserve = createServer(); const port = await listen(reserve); await new Promise((resolve) => reserve.close(resolve));
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 1,
    proxy: { currentProviderId: "p0", autoFailoverEnabled: true, maxAttempts: handlers.length,
      preferredProviderMaxAttempts: 1, providerMaxAttempts: 1,
      streamingFirstByteTimeoutMs: 2000, streamingIdleTimeoutMs: 5000 },
    providers: upstreams.map((u, n) => ({ id: `p${n}`, name: `本机伪供应商${n}`, baseUrl: `http://127.0.0.1:${u.port}`,
      apiKey: "fake-local-only", routingEnabled: true, sortIndex: n + 1 })),
    connectivityTest: { periodicIntervalMs: null },
  }));
  await writeFile(path.join(profile, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fake-local-only" }));
  await writeFile(path.join(profile, "config.toml"), `model = "gpt-6.1-sol"
model_provider = "isolated_lite"
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false
[model_providers.isolated_lite]
name = "本机隔离测试"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "LITE_TEST_FAKE_KEY"
requires_openai_auth = false
wire_api = "responses"
supports_websockets = false
request_max_retries = 2
stream_max_retries = 2
stream_idle_timeout_ms = 10000
`);
  const servers = []; const clients = []; const env = cleanEnvironment();
  const status = () => fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(300) }).then((r) => r.json());
  const start = async () => {
    const server = tracked(process.execPath, [path.join(code, "server.js")], { cwd: code,
      env: { ...env, LITE_CCSWITCH_DATA_DIR: data, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(port),
        LITE_CCSWITCH_RECOVERY_PROBE_INTERVAL_MS: "60000" } });
    servers.push(server);
    await until(async () => {
      if (server.child.exitCode !== null) throw new Error(server.stderr());
      try { const s = await status(); return s.processId === server.child.pid && s; } catch { return false; }
    });
    return server;
  };
  const clientEnv = { ...env,
      LITE_TEST_FAKE_KEY: "fake-local-only", CODEX_PORTABLE_STATE_ROOT: state,
      CODEX_PORTABLE_CONFIGS_ROOT: path.join(state, "configs"), CODEX_PORTABLE_HOME: path.join(state, "sessions"),
      CODEX_PORTABLE_PROJECT_ROOT: workspace, CODEX_PORTABLE_WORKSPACE_DIR: workspace,
      CODEX_PORTABLE_NO_PROFILE_PROMPT: "1", CODEX_NODE_BIN: process.execPath, CODEX_BIN: codexBin,
  };
  const run = (command = "exec", extra = []) => {
    const client = tracked("/bin/bash", [path.join(portable, "bin/codex-project"), command, "--profile", "cct", ...extra,
      "--json", "只执行隔离测试指定的本地命令，然后回复 ISOLATED_OK。"], { cwd: workspace, env: clientEnv });
    clients.push(client);
    return client;
  };
  const runInteractive = () => {
    const client = tracked("python3", [path.join(code, "tests/manual/test-codex-pty.py"), "/bin/bash", path.join(portable, "bin/codex-project"),
      "start", "--profile", "cct", "--no-alt-screen", "只回复 ISOLATED_OK。"],
    { cwd: workspace, stdio: ["pipe", "pipe", "pipe"], env: { ...clientEnv, TERM: "xterm-256color", COLUMNS: "120", LINES: "40" } });
    // 虚拟终端没有终端模拟器，需回答 Codex 的光标位置查询才能完成初始化。
    client.child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("\x1b[6n")) client.child.stdin.write("\x1b[1;1R");
    });
    clients.push(client);
    return client;
  };
  const finishClient = async (client) => {
    const timer = setTimeout(() => groupSignal(client.child, "SIGTERM"), 35000);
    const hardTimer = setTimeout(() => groupSignal(client.child, "SIGKILL"), 38000);
    try { return await client.exit; } finally { clearTimeout(timer); clearTimeout(hardTimer); }
  };
  const cleanup = async () => {
    let cleanupError;
    for (const client of clients) await stop(client);
    // TUI 的托管守护进程脱离客户端进程组；用独立 CODEX_HOME 的官方命令停止它。
    try {
      await readFile(path.join(state, "sessions/app-server-daemon/daemon.pid"));
      const shutdown = tracked(process.execPath, [codexBin, "app-server", "daemon", "stop"],
        { cwd: workspace, env: { ...clientEnv, CODEX_HOME: path.join(state, "sessions") } });
      clients.push(shutdown);
      const timer = setTimeout(() => groupSignal(shutdown.child, "SIGTERM"), 8000);
      const hardTimer = setTimeout(() => groupSignal(shutdown.child, "SIGKILL"), 10000);
      try { assert.equal((await shutdown.exit).code, 0, shutdown.stderr()); }
      finally { clearTimeout(timer); clearTimeout(hardTimer); }
    } catch (error) { if (error.code !== "ENOENT") cleanupError = error; }
    for (const { server } of upstreams) server.closeAllConnections();
    for (const server of servers) await stop(server);
    for (const { server } of upstreams) await new Promise((resolve) => server.close(resolve));
    for (const [n, p] of [...servers, ...clients].entries()) {
      await writeFile(path.join(dir, `process-${n}.stdout.log`), p.stdout());
      await writeFile(path.join(dir, `process-${n}.stderr.log`), p.stderr());
    }
    await writeFile(path.join(dir, "requests.json"), JSON.stringify(calls, null, 2));
    await writeFile(path.join(dir, "auxiliary-requests.json"), JSON.stringify(auxiliaryCalls, null, 2));
    if (cleanupError) throw cleanupError;
  };
  try { const server = await start(); return { dir, data, workspace, calls, status, server, start, run, runInteractive, finishClient, cleanup }; }
  catch (error) { await cleanup(); throw error; }
}
function cliEvents(client) {
  return client.stdout().split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function assertCompleted(client, exit) {
  assert.equal(exit.code, 0, client.stdout() + client.stderr());
  const events = cliEvents(client);
  assert.ok(events.some((e) => e.type === "turn.completed"), client.stdout() + client.stderr());
  assert.ok(!events.some((e) => e.type === "turn.failed"));
  return events;
}
const scenarios = {
  async tools() {
    let f;
    f = await fixture("tools", [(req, res) => {
      prelude(res, "resp_failed_primary");
      setTimeout(() => res.end(event("response.failed", { response: { id: "resp_failed_primary", status: "failed",
        error: { code: "server_overloaded", message: "Our servers are currently overloaded. Please try again later." } } })), 60);
    }, (req, res, body) => {
      if (body.input?.some((item) => ["function_call_output", "custom_tool_call_output"].includes(item.type))) return textResponse(res, "ISOLATED_OK");
      const advertised = [...(body.tools || []), ...(body.input || []).filter((item) => item.type === "additional_tools").flatMap((item) => item.tools || [])];
      const tools = advertised.flatMap((tool) => tool.type === "namespace"
        ? tool.tools.map((item) => ({ ...item, namespace: tool.name })) : [tool]);
      const tool = tools.find((item) => ["exec_command", "shell_command", "shell"].includes(item.name)) ||
        tools.find((item) => item.type === "custom" && item.name === "exec" && item.namespace === "functions");
      assert.ok(tool, `未找到可用本地命令工具：${tools.map((t) => t.name).join(",")}`);
      const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
      const command = `/usr/bin/printf '%s\\n' once >> ${quote(path.join(f.workspace, "counter.log"))}`;
      const properties = tool.parameters?.properties || {};
      const args = properties.cmd ? { cmd: command } : { command: properties.command?.type === "array" ? ["/bin/sh", "-c", command] : command };
      if (properties.workdir) args.workdir = f.workspace;
      if (properties.login) args.login = false;
      const custom = tool.type === "custom";
      const payload = custom ? `text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: f.workspace, login: false })}));` : JSON.stringify(args);
      const item = { id: "fc_once", type: custom ? "custom_tool_call" : "function_call", call_id: "call_once", name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}), [custom ? "input" : "arguments"]: payload, status: "completed" };
      prelude(res, "resp_tool");
      res.write(event("response.output_item.added", { output_index: 0, item: { ...item, [custom ? "input" : "arguments"]: "", status: "in_progress" } }));
      const field = custom ? "custom_tool_call_input" : "function_call_arguments";
      res.write(event(`response.${field}.delta`, { output_index: 0, item_id: item.id, delta: payload }));
      res.write(event(`response.${field}.done`, { output_index: 0, item_id: item.id, [custom ? "input" : "arguments"]: payload }));
      res.write(event("response.output_item.done", { output_index: 0, item }));
      res.end(event("response.completed", { response: responseObject("resp_tool", [item]) }));
    }]);
    try {
      const client = f.run(); const events = assertCompleted(client, await f.finishClient(client));
      const counter = await readFile(path.join(f.workspace, "counter.log"), "utf8");
      assert.equal(counter, "once\n", "工具必须恰好执行一次");
      assert.equal(events.filter((e) => e.type === "item.completed" && e.item?.type === "command_execution" && e.item.exit_code === 0).length, 1);
      assert.equal(f.calls[0].length, 1); assert.equal(f.calls[1].length, 2);
      assert.deepEqual(f.calls[0][0].body, f.calls[1][0].body, "故障转移须原样重发请求");
      const threadId = events.find((e) => e.type === "thread.started")?.thread_id;
      assert.ok(threadId);
      const resumed = f.run("exec-resume", [threadId]);
      const resumeEvents = assertCompleted(resumed, await f.finishClient(resumed));
      assert.equal(resumeEvents.find((e) => e.type === "thread.started")?.thread_id, threadId);
      assert.equal(await readFile(path.join(f.workspace, "counter.log"), "utf8"), "once\n", "恢复对话不能重复执行既有工具");
      assert.equal(f.calls[0].length, 1); assert.equal(f.calls[1].length, 3);
      const usage = await until(async () => {
        try {
          const rows = (await readFile(path.join(f.data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
          return rows.length === 3 && rows;
        } catch { return false; }
      });
      assert.equal(usage[0].providerAttempts[0].streamDiagnostics.forwardedBytes, 0);
      return { threadId, resumed: true, primaryRequests: f.calls[0].length,
        fallbackRequests: f.calls[1].length, toolExecutions: 1, failedAttemptForwardedBytes: 0 };
    } finally { await f.cleanup(); }
  },
  async cancel() {
    let closedAt = 0;
    const f = await fixture("cancel", [(req, res) => { res.once("close", () => { closedAt = Date.now(); }); },
      (req, res) => textResponse(res, "UNEXPECTED_FALLBACK")]);
    try {
      const client = f.run(); await until(() => f.calls[0].length === 1, 30000);
      const cancelledAt = Date.now(); const exit = await stop(client, "SIGINT");
      await until(async () => (await f.status()).activeConnections === 0);
      await until(() => closedAt > 0);
      assert.equal(f.calls[1].length, 0); assert.equal(f.calls[0].length, 1);
      const s = await f.status(); assert.ok(s.providers.every((p) => p.circuit.failedRequests === 0));
      assert.ok(s.recoveryProbes.every((p) => !p.running && !p.scheduledAt));
      assert.ok(closedAt - cancelledAt < 1000);
      return { exit, upstreamAbortDelayMs: closedAt - cancelledAt, primaryRequests: f.calls[0].length, fallbackRequests: 0 };
    } finally { await f.cleanup(); }
  },
  async "cancel-tui"() {
    let closedAt = 0;
    const f = await fixture("cancel-tui", [(req, res, body, count) => {
      if (count > 1) return textResponse(res, "ISOLATED_OK");
      res.once("close", () => { closedAt = Date.now(); });
    }, (req, res) => textResponse(res, "UNEXPECTED_FALLBACK")]);
    try {
      const client = f.runInteractive(); await until(() => f.calls[0].length === 1, 30000);
      const cancelledAt = Date.now(); client.child.stdin.write("\x1b");
      await until(() => closedAt > 0, 5000);
      await until(async () => (await f.status()).activeConnections === 0);
      assert.equal(client.child.exitCode, null, "Esc 只应取消本轮，不能退出会话");
      assert.equal(f.calls[0].length, 1); assert.equal(f.calls[1].length, 0);
      assert.ok(closedAt - cancelledAt < 1000);
      client.child.stdin.write("继续隔离测试\r");
      await until(async () => f.calls[0].length === 2 && (await f.status()).activeConnections === 0, 10000);
      await until(() => client.stdout().includes("ISOLATED_OK"));
      assert.equal(f.calls[0].length, 2); assert.equal(f.calls[1].length, 0);
      const s = await f.status(); assert.ok(s.providers.every((p) => p.circuit.failedRequests === 0));
      client.child.stdin.write("\x04"); await f.finishClient(client);
      return { entry: "codex-project start --profile cct", cancellation: "Esc", upstreamAbortDelayMs: closedAt - cancelledAt,
        primaryRequests: 2, fallbackRequests: 0, nextTurnCompleted: true };
    } finally { await f.cleanup(); }
  },
  async restart() {
    const f = await fixture("restart", [(req, res, body, count) => {
      if (count > 1) return textResponse(res, "ISOLATED_OK");
      prelude(res, "resp_before_restart");
      res.write(event("response.output_text.delta", { delta: "partial" }));
    }]);
    try {
      const client = f.run(); await until(() => f.calls[0].length === 1, 30000); await pause(100);
      f.server.child.kill("SIGTERM"); await pause(150);
      assert.equal(f.server.child.exitCode, null, "第一信号应等待现有流");
      f.server.child.kill("SIGTERM"); await f.server.exit;
      const replacement = await f.start();
      const exit = await f.finishClient(client); const events = assertCompleted(client, exit);
      assert.ok(f.calls[0].length >= 2, "未观察到 CLI 重发请求");
      return { threadId: events.find((e) => e.type === "thread.started")?.thread_id,
        stoppedPid: f.server.child.pid, replacementPid: replacement.child.pid, requests: f.calls[0].length };
    } finally { await f.cleanup(); }
  },
};
const report = { createdAt: new Date().toISOString(), root, source: SOURCE, sourceSnapshotHash: manifest.contentHash,
  chain: "复制的 codex-project --profile cct → 独立 Lite → 本机伪供应商", realProviders: false, results: [] };
for (const name of selected === "all" ? Object.keys(scenarios) : [selected]) {
  console.log(`开始场景：${name}`);
  try { const evidence = await scenarios[name](); report.results.push({ name, passed: true, ...evidence }); }
  catch (error) { report.results.push({ name, passed: false, error: error.stack }); process.exitCode = 1; }
  await writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.results.at(-1)));
}
console.log(`验收记录：${path.join(root, "result.json")}`);
