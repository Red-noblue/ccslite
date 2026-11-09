/**
 * 独立进程与本机伪上游验证业务恢复回迁、流式完成确认及多分组统一周期去重。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DAY = 24 * 60 * 60_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function waitFor(check) {
  for (let index = 0; index < 200; index += 1) {
    if (await check()) return;
    await pause(25);
  }
  throw new Error("等待隔离测试状态超时");
}

async function fixture(t, { periodic = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "lite-business-recovery-"));
  const calls = [];
  const failedModels = new Set();
  const held = [];
  let serial = 0;
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const provider = req.headers.authorization === "Bearer a" ? "a" : "b";
    const probe = raw.includes("请只回复 CCOK");
    calls.push({ provider, model: body.model, probe, previous: body.previous_response_id });
    if (provider === "a" && failedModels.has(body.model)) {
      res.writeHead(503); res.end("模拟首选供应商故障"); return;
    }
    if (provider === "a" && body.previous_response_id?.startsWith("resp-b-")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Previous response with id not found" } })); return;
    }
    const id = `resp-${provider}-${++serial}`;
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "测试" })}\n\n`);
      held.push(() => res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, model: body.model, output: [{ content: [{ type: "output_text", text: probe ? "CCOK" : provider }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  await writeFile(path.join(dir, "config.json"), JSON.stringify({
    version: 2,
    proxy: { autoFailoverEnabled: true, maxAttempts: 2, preferredProviderMaxAttempts: 1, providerMaxAttempts: 1, circuit: { failureThreshold: 100, minRequests: 100 } },
    providers: ["a", "b"].map((id, index) => ({ id, name: id, apiKey: id, baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, routingEnabled: periodic ? id === "a" : true, sortIndex: index + 1, modelSupport: { preferredTestModel: "model-a" } })),
    connectivityTest: { periodicIntervalMs: periodic ? DAY : null, candidateModels: ["model-a"] },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  // 仅在此测试子进程压缩第一次每日计时，真实上游仍通过 HTTP 完整请求。
  const preload = "const timer=globalThis.setTimeout;let first=true;globalThis.setTimeout=(fn,ms,...args)=>{if(first&&ms>86390000&&ms<=86400000){first=false;return timer(fn,1000,...args)}return timer(fn,ms,...args)}";
  const args = periodic ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(ROOT, "server.js")] : [path.join(ROOT, "server.js")];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "pipe", env: { ...env, LITE_CCSWITCH_DATA_DIR: dir, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(port), LITE_CCSWITCH_RECOVERY_PROBE_INTERVAL_MS: "60000" } });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; }); child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    held.splice(0).forEach((finish) => finish());
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(logs);
    try { return (await fetch(base + "/api/status")).ok; } catch { return false; }
  });
  const api = async (url, method = "GET", body) => {
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const request = async (session, { targetPort = port, model = "model-a", ...body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${targetPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": session }, body: JSON.stringify({ model, input: "真实业务测试", ...body }) });
    assert.equal(response.status, 200); return response;
  };
  const routed = async (session, provider, options) => {
    const response = await request(session, options);
    assert.equal(response.headers.get("x-lite-ccswitch-provider-id"), provider);
    return response.json();
  };
  return { api, request, routed, failedModels, held, calls, dir };
}

test("业务连续成功回迁旧会话，按组优先级和模型隔离，并保留响应上下文回退", { timeout: 15000 }, async (t) => {
  const { api, request, routed, failedModels, held, calls, dir } = await fixture(t);
  const quality = await api("/api/groups", "POST", { name: "乙优先", providerRefs: [{ providerId: "b", enabled: true, sortIndex: 1 }, { providerId: "a", enabled: true, sortIndex: 2 }] });
  await routed("same", "b", { targetPort: quality.actualListener.port });
  failedModels.add("model-a"); failedModels.add("model-b");
  const old = await routed("same", "b");
  await routed("other-model", "b", { model: "model-b" });
  failedModels.clear();
  await routed("fresh-1", "a");
  await routed("same", "b");
  let status = await api("/api/status");
  assert.ok(status.recoveryProbes.find((item) => item.providerId === "a").scheduledAt, "一次业务成功后必须保留确认探测");
  // 第二次请求只收到流式开头时不能确认，完整输出结束后才能回迁。
  const stream = await request("fresh-stream", { stream: true });
  await waitFor(() => held.length === 1);
  await routed("same", "b");
  held.shift()(); assert.match(await stream.text(), /response.completed/);
  await waitFor(async () => !(await api("/api/status")).recoveryProbes.find((item) => item.providerId === "a").pendingModels.includes("model-a"));
  await routed("same", "a");
  await routed("same", "b", { targetPort: quality.actualListener.port });
  await routed("other-model", "b", { model: "model-b" });
  await routed("fresh-model-b-1", "a", { model: "model-b" });
  await routed("other-model", "b", { model: "model-b" });
  await routed("fresh-model-b-2", "a", { model: "model-b" });
  await routed("other-model", "a", { model: "model-b" });
  await routed("same", "b", { previous_response_id: old.id });
  assert.ok(calls.some((call) => call.provider === "a" && call.previous === old.id), "迁移后应先尝试首选供应商，再按上下文回退");
  await routed("same", "a");
  assert.equal(calls.filter((call) => call.probe).length, 0, "业务已完成确认后无需额外计费探测");
  status = await api("/api/status");
  assert.ok(status.groups.find((group) => group.id === quality.id).providerActivity.providers.every((provider) => provider.providerId === "b"));
  const usageRecords = (await readFile(path.join(dir, "usage.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(usageRecords.some((record) => record.routeReason === "failover"), "故障转移请求应记录原因");
  assert.ok(usageRecords.some((record) => record.routeReason === "recovered_migration"), "恢复迁移请求应记录原因");
  assert.ok(usageRecords.some((record) => record.routeReason === "previous_response_fallback"), "上下文回退请求应记录原因");
});

test("完整响应结束时不把恢复后的高优先级粘滞覆盖回旧供应商", { timeout: 15000 }, async (t) => {
  const { request, routed, failedModels, held } = await fixture(t);
  failedModels.add("model-a");

  // 首选供应商先失败，长请求随后切到低优先级供应商并保持在途。
  const stream = await request("race", { stream: true });
  await waitFor(() => held.length === 1);

  failedModels.clear();
  await routed("recover-1", "a");
  await routed("recover-2", "a");

  // 此时猫猫1已经完成两次成功确认；旧的猫猫2响应最后结束不能把会话写回猫猫2。
  held.shift()();
  assert.match(await stream.text(), /response.completed/);
  await routed("race", "a");
});

test("后来启动的分组沿用同一每日周期，复制供应商只检测一次且覆盖独有供应商", { timeout: 15000 }, async (t) => {
  const { api, calls, dir } = await fixture(t, { periodic: true });
  const nextRunAt = (await api("/api/status")).connectivityTest.nextRunAt;
  await api("/api/groups/default/clone", "POST", { name: "完全复制" });
  const quality = await api("/api/groups", "POST", { name: "包含独有乙", providerRefs: [{ providerId: "a", enabled: true }, { providerId: "b", enabled: true }] });
  assert.equal((await api("/api/status")).connectivityTest.nextRunAt, nextRunAt);
  await waitFor(async () => (await api("/api/status")).connectivityTest.lastRunReason === "periodic");
  assert.deepEqual(calls.filter((call) => call.probe).map((call) => call.provider).sort(), ["a", "b"]);
  const rawRecords = await readFile(path.join(dir, "usage.jsonl"), "utf8");
  assert.ok(rawRecords.trim(), JSON.stringify((await api("/api/status")).persistence));
  const records = rawRecords.split("\n").filter((line) => line.trim()).map(JSON.parse);
  assert.equal(records.length, 2, "共享检测只记录两笔实际请求，不能按分组重复记账");
  assert.equal(records.find((record) => record.providerId === "a").groupId, "default");
  assert.equal(records.find((record) => record.providerId === "b").groupId, quality.id);
  assert.equal((await api("/api/status")).connectivityTest.nextRunAt, nextRunAt, "提前触发的测试计时不应改变首次启动的周期基准");
});
