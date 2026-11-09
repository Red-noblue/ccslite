/**
 * SSE 前导阶段安全故障转移集成测试。
 * 使用本机伪上游验证有效输出前可重试、输出后不可拼接其他供应商。
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CREATED = 'event: response.created\ndata: {"type":"response.created"}\n\n';
const IN_PROGRESS = 'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n';
const COMPLETED = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitForServer(url, logs) {
  for (let index = 0; index < 60; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 等待测试服务启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`服务启动超时：${logs()}`);
}

async function createProxy(t, providers, proxy = {}) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-stream-failover-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const port = await reservePort();
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  let logs = "";
  let child;
  const start = () => {
    child = spawn(process.execPath, [path.join(TOOL_ROOT, "server.js")], {
      cwd: TOOL_ROOT,
      env: {
        ...cleanEnv,
        LITE_CCSWITCH_DATA_DIR: tempRoot,
        LITE_CCSWITCH_HOST: "127.0.0.1",
        LITE_CCSWITCH_PORT: String(port),
        LITE_CCSWITCH_CONFIG: configPath,
        LITE_CCSWITCH_USAGE: usagePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
    child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  };
  const stop = async () => {
    if (child?.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };

  t.after(async () => {
    await stop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: true,
      currentProviderId: providers[0].id,
      maxAttempts: providers.length,
      preferredProviderMaxAttempts: 1,
      providerMaxAttempts: 1,
      retryScheduleChunkSize: 1,
      streamingFirstByteTimeoutMs: 3000,
      streamingIdleTimeoutMs: 3000,
      ...proxy,
    },
    providers: providers.map(({ id, name, port: upstreamPort }, index) => ({
      id,
      name,
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "test-key",
      enabled: true,
      inFailoverQueue: true,
      sortIndex: index + 1,
    })),
    connectivityTest: { periodicIntervalMs: null },
  }, null, 2));

  const baseUrl = `http://127.0.0.1:${port}`;
  start();
  await waitForServer(`${baseUrl}/api/status`, () => logs);
  return { baseUrl, usagePath, restart: async () => {
    await stop();
    start();
    await waitForServer(`${baseUrl}/api/status`, () => logs);
  } };
}

async function waitForDiagnostics(proxy) {
  for (let index = 0; index < 100; index += 1) {
    const status = await fetch(`${proxy.baseUrl}/api/status`).then((response) => response.json());
    const group = status.groups.find((item) => item.id === "default");
    if (group.statistics.activeConnections === 0 && group.statistics.totalRequests > 0) return { status, group };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("请求结束后统计未完成");
}

async function waitForUsage(usagePath) {
  for (let index = 0; index < 60; index += 1) {
    try {
      const records = (await readFile(usagePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      if (records.length) return records;
    } catch {
      // 等待请求用量记录完成写入。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("流式故障转移用量记录未写入");
}

test("生命周期前导阶段断流时切换供应商并只转发成功供应商的流", async (t) => {
  let primaryRequests = 0;
  let fallbackRequests = 0;
  const primary = createServer((req, res) => {
    primaryRequests += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "x-primary-only": "must-not-leak" });
    res.write(CREATED);
    setTimeout(() => res.write(IN_PROGRESS), 30);
    setTimeout(() => res.destroy(), 80);
  });
  const fallback = createServer((req, res) => {
    fallbackRequests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(CREATED);
    res.write(IN_PROGRESS);
    setTimeout(() => {
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"fallback"}\n\n');
      res.write(COMPLETED);
    }, 30);
  });
  const primaryPort = await listen(primary);
  const fallbackPort = await listen(fallback);
  t.after(async () => {
    await close(primary);
    await close(fallback);
  });

  const proxy = await createProxy(t, [
    { id: "primary", name: "首选供应商", port: primaryPort },
    { id: "fallback", name: "备用供应商", port: fallbackPort },
  ]);
  const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer local-test", "content-type": "application/json" },
    body: JSON.stringify({ model: "stream-test", input: "test", stream: true }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-id"), "fallback");
  assert.equal(response.headers.get("x-primary-only"), null);
  const body = await response.text();
  assert.match(body, /fallback/);
  assert.match(body, /response\.completed/);
  assert.equal(primaryRequests, 1);
  assert.equal(fallbackRequests, 1);
  const [record] = await waitForUsage(proxy.usagePath);
  const primaryAttempt = record.providerAttempts.find((attempt) => attempt.providerId === "primary");
  assert.equal(primaryAttempt.failureClass, "transport");
  assert.equal(primaryAttempt.streamDiagnostics.forwardedBytes, 0);
  const { status, group } = await waitForDiagnostics(proxy);
  assert.equal(group.statistics.totalRequests, 1);
  assert.equal(group.statistics.streamDiagnostics.streamAttempts, 2);
  assert.equal(group.statistics.streamDiagnostics.preOutputFailovers, 1);
  assert.equal(group.statistics.streamDiagnostics.transportErrors, 1);
  assert.equal(group.statistics.streamDiagnostics.midStreamDisconnects, 0);
  assert.ok(group.statistics.streamDiagnostics.firstByteAverageMs >= 0);
  assert.deepEqual(status.streamDiagnostics, group.statistics.streamDiagnostics);
  await proxy.restart();
  const restored = await waitForDiagnostics(proxy);
  assert.deepEqual(restored.group.statistics.streamDiagnostics, group.statistics.streamDiagnostics);
});

test("有效输出已发出后断流不会拼接备用供应商响应", async (t) => {
  let fallbackRequests = 0;
  const primary = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(CREATED);
    setTimeout(() => res.write(IN_PROGRESS), 20);
    setTimeout(() => res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'), 40);
    setTimeout(() => res.destroy(), 90);
  });
  const fallback = createServer((req, res) => {
    fallbackRequests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${CREATED}${IN_PROGRESS}event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"fallback"}\n\n${COMPLETED}`);
  });
  const primaryPort = await listen(primary);
  const fallbackPort = await listen(fallback);
  t.after(async () => {
    await close(primary);
    await close(fallback);
  });

  const proxy = await createProxy(t, [
    { id: "primary", name: "首选供应商", port: primaryPort },
    { id: "fallback", name: "备用供应商", port: fallbackPort },
  ]);
  const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer local-test", "content-type": "application/json" },
    body: JSON.stringify({ model: "stream-test", input: "test", stream: true }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-id"), "primary");
  await assert.rejects(response.text());
  assert.equal(fallbackRequests, 0);
  await waitForUsage(proxy.usagePath);
  const { group } = await waitForDiagnostics(proxy);
  assert.equal(group.statistics.totalRequests, 1);
  assert.equal(group.statistics.streamDiagnostics.midStreamDisconnects, 1);
  assert.equal(group.statistics.streamDiagnostics.preOutputFailovers, 0);
});

test("输出后静默超时单独统计且不拼接其他供应商", async (t) => {
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`${CREATED}${IN_PROGRESS}event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n`);
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxy(t, [{ id: "idle", name: "静默测试", port }], { streamingIdleTimeoutMs: 250 });
  const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "stream-test", input: "test", stream: true }),
  });
  await assert.rejects(response.text());
  await waitForUsage(proxy.usagePath);
  const { group } = await waitForDiagnostics(proxy);
  assert.equal(group.statistics.streamDiagnostics.idleTimeouts, 1);
  assert.equal(group.statistics.streamDiagnostics.midStreamDisconnects, 1);
  assert.equal(group.statistics.streamDiagnostics.preOutputFailovers, 0);
});

for (const mode of ["client", "operator"]) {
  test(`${mode === "client" ? "客户端主动断开" : "管理台人工取消"}不计入上游断流`, async (t) => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`${CREATED}${IN_PROGRESS}event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n`);
    });
    const port = await listen(upstream);
    t.after(() => close(upstream));
    const proxy = await createProxy(t, [{ id: mode, name: "取消测试", port }]);
    const controller = new AbortController();
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": `${mode}-test` },
      body: JSON.stringify({ model: "stream-test", input: "test", stream: true }),
      signal: controller.signal,
    });
    const active = await fetch(`${proxy.baseUrl}/api/requests/active?groupId=default`).then((result) => result.json());
    const request = active.requests.find((item) => item.requestId === `${mode}-test`);
    assert.ok(request?.firstByteAt);
    assert.ok(request?.clientFirstByteAt);
    assert.ok(request?.lastChunkAt);
    if (mode === "client") controller.abort();
    else {
      const cancelled = await fetch(`${proxy.baseUrl}/api/requests/${request.id}/cancel`, { method: "POST" }).then((result) => result.json());
      assert.equal(cancelled.ok, true);
    }
    await assert.rejects(response.text());
    const [record] = await waitForUsage(proxy.usagePath);
    assert.equal(record.providerAttempts.length, 1);
    assert.equal(record.failureClass, mode === "client" ? "client_connection_closed" : "operator_cancelled");
    const { group } = await waitForDiagnostics(proxy);
    assert.equal(group.statistics.streamDiagnostics.clientDisconnects, mode === "client" ? 1 : 0);
    assert.equal(group.statistics.streamDiagnostics.midStreamDisconnects, 0);
    assert.equal(group.statistics.streamDiagnostics.preOutputFailures, 0);
    assert.equal(group.statistics.streamDiagnostics.transportErrors, 0);
    assert.equal(group.statistics.streamDiagnostics.idleTimeouts, 0);
    const finished = await fetch(`${proxy.baseUrl}/api/requests/active`).then((result) => result.json());
    assert.equal(finished.active, 0);
  });
}

for (const mode of ["created", "heartbeat"]) {
  test(`${mode === "created" ? "生命周期事件后" : "未验证前导"}持续心跳超时会关闭上游并切换，诊断重启后保留`, async (t) => {
    let primaryClosed = false;
    let fallbackRequests = 0;
    const primary = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(mode === "created" ? CREATED : ": heartbeat\n\n");
      const timer = setInterval(() => res.write(": heartbeat\n\n"), 20);
      res.once("close", () => { clearInterval(timer); primaryClosed = true; });
    });
    const fallback = createServer((req, res) => {
      fallbackRequests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: {"type":"response.output_text.delta","delta":"fallback"}\n\n${COMPLETED}`);
    });
    const primaryPort = await listen(primary);
    const fallbackPort = await listen(fallback);
    t.after(async () => {
      primary.closeAllConnections(); fallback.closeAllConnections();
      await close(primary); await close(fallback);
    });
    const proxy = await createProxy(t, [
      { id: "primary", name: "心跳首选", port: primaryPort },
      { id: "fallback", name: "正常备用", port: fallbackPort },
    ], { streamingProgressTimeoutMs: 150, streamingDeferredOutputGraceMs: 1000 });
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stream-test", input: "test", stream: true }),
    });
    assert.equal(response.headers.get("x-lite-ccswitch-provider-id"), "fallback");
    assert.match(await response.text(), /fallback/);
    assert.equal(fallbackRequests, 1);
    const [record] = await waitForUsage(proxy.usagePath);
    const attempt = record.providerAttempts[0];
    assert.equal(attempt.failureClass, "stream_progress_timeout");
    assert.equal(attempt.streamDiagnostics.outputStarted, false);
    assert.equal(attempt.streamDiagnostics.termination, "upstream_progress_timeout");
    assert.equal(attempt.streamDiagnostics.progressTimeoutMs, 150);
    const { group } = await waitForDiagnostics(proxy);
    assert.equal(primaryClosed, true);
    assert.equal(group.statistics.streamDiagnostics.progressTimeouts, 1);
    assert.equal(group.statistics.streamDiagnostics.idleTimeouts, 0);
    assert.equal(group.statistics.streamDiagnostics.transportErrors, 0);
    assert.equal(group.statistics.streamDiagnostics.preOutputFailovers, 1);
    await proxy.restart();
    assert.deepEqual((await waitForDiagnostics(proxy)).group.statistics.streamDiagnostics, group.statistics.streamDiagnostics);
  });
}

test("回退窗口结束后已发送的生命周期流无进展超时，不会拼接备用供应商", async (t) => {
  let fallbackRequests = 0;
  const primary = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(CREATED);
    const timer = setInterval(() => res.write(": heartbeat\n\n"), 20);
    res.once("close", () => clearInterval(timer));
  });
  const fallback = createServer((req, res) => { fallbackRequests += 1; res.end(COMPLETED); });
  const primaryPort = await listen(primary);
  const fallbackPort = await listen(fallback);
  t.after(async () => {
    primary.closeAllConnections(); fallback.closeAllConnections();
    await close(primary); await close(fallback);
  });
  const proxy = await createProxy(t, [
    { id: "primary", name: "已转发流", port: primaryPort },
    { id: "fallback", name: "不得拼接", port: fallbackPort },
  ], { streamingProgressTimeoutMs: 300, streamingDeferredOutputGraceMs: 40 });
  const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "stream-test", input: "test", stream: true }),
  });
  assert.equal(response.headers.get("x-lite-ccswitch-provider-id"), "primary");
  await assert.rejects(response.text());
  assert.equal(fallbackRequests, 0);
  const [record] = await waitForUsage(proxy.usagePath);
  assert.equal(record.providerAttempts.length, 1);
  assert.equal(record.providerAttempts[0].streamDiagnostics.events.semanticStarted, false);
  assert.equal(record.providerAttempts[0].streamDiagnostics.outputStarted, true);
  const { group } = await waitForDiagnostics(proxy);
  assert.equal(group.statistics.streamDiagnostics.progressTimeouts, 1);
  assert.equal(group.statistics.streamDiagnostics.midStreamDisconnects, 1);
});

test("持续有效输出超过无进展阈值仍可完成，运行中修改只影响后续尝试", async (t) => {
  let started;
  const firstOutput = new Promise((resolve) => { started = resolve; });
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`${CREATED}data: {"type":"response.output_text.delta","delta":"start"}\n\n`);
    started();
    let count = 0;
    const timer = setInterval(() => {
      res.write(`data: {"type":"response.output_text.delta","delta":"chunk-${++count}"}\n\n`);
      if (count === 6) { clearInterval(timer); res.end(COMPLETED); }
    }, 60);
    res.once("close", () => clearInterval(timer));
  });
  const port = await listen(upstream);
  t.after(async () => { upstream.closeAllConnections(); await close(upstream); });
  const proxy = await createProxy(t, [{ id: "progress", name: "有效进展", port }], { streamingProgressTimeoutMs: 200 });
  const pending = fetch(`${proxy.baseUrl}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "stream-test", input: "test", stream: true }),
  });
  await firstOutput;
  const changed = await fetch(`${proxy.baseUrl}/api/config`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ proxy: { streamingProgressTimeoutMs: 1 } }),
  });
  assert.equal(changed.status, 200);
  assert.match(await (await pending).text(), /chunk-6/);
  const [record] = await waitForUsage(proxy.usagePath);
  assert.ok(record.latencyMs >= 300);
  assert.equal(record.providerAttempts[0].streamDiagnostics.progressTimeoutMs, 200);
  const { group } = await waitForDiagnostics(proxy);
  assert.equal(group.statistics.streamDiagnostics.progressTimeouts, 0);
});

test("流式等待配置默认值、零值、部分保存与重启后显示保持一致", async (t) => {
  const proxy = await createProxy(t, [{ id: "config", name: "只测配置", port: 1 }]);
  const get = () => fetch(`${proxy.baseUrl}/api/config`).then((response) => response.json());
  const initial = await get();
  assert.equal(initial.proxy.streamingDeferredOutputGraceMs, 1500);
  assert.equal(initial.proxy.streamingDeferredBufferBytes, 262144);
  assert.equal(initial.proxy.streamingProgressTimeoutMs, 0);
  const update = async (values) => {
    const response = await fetch(`${proxy.baseUrl}/api/config`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ proxy: values }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await update({ streamingDeferredOutputGraceMs: 0, streamingDeferredBufferBytes: 4096, streamingProgressTimeoutMs: 0 });
  await update({ autoFailoverEnabled: false });
  await proxy.restart();
  const restored = await get();
  assert.equal(restored.proxy.streamingDeferredOutputGraceMs, 0);
  assert.equal(restored.proxy.streamingDeferredBufferBytes, 4096);
  assert.equal(restored.proxy.streamingProgressTimeoutMs, 0);
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate) {
  for (let n = 0; n < 100; n += 1) {
    if (await predicate()) return;
    await pause(20);
  }
  throw new Error("等待取消测试状态超时");
}
function postResponse(proxy, { signal, stream = true, requestId = "cancel-test" } = {}) {
  return fetch(`${proxy.baseUrl}/v1/responses`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ model: "stream-test", input: "test", stream }),
  });
}
function completeResponse(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`${CREATED}data: {"type":"response.output_text.delta","delta":"fallback"}\n\n${COMPLETED}`);
}
async function closeUpstreams(...servers) {
  for (const server of servers) { server.closeAllConnections(); await close(server); }
}

for (const phase of ["headers", "first-byte", "prelude", "error-body", "error-body-buffer", "buffer"]) {
  test(`${phase} 阶段客户端取消立即中止上游，不追加尝试或恢复探测`, async (t) => {
    let primaryRequests = 0;
    let fallbackRequests = 0;
    let primaryClosed = false;
    const primary = createServer((req, res) => {
      primaryRequests += 1;
      res.once("close", () => { primaryClosed = true; });
      if (phase === "headers") return;
      res.writeHead(phase.startsWith("error-body") ? 503 : 200, {
        "content-type": phase.includes("buffer") || phase.startsWith("error-body") ? "application/json" : "text/event-stream",
      });
      res.flushHeaders();
      if (phase === "prelude") res.write(": unvalidated prelude\n\n");
      if (phase.startsWith("error-body") || phase === "buffer") res.write('{"message":"partial');
    });
    const fallback = createServer((req, res) => { fallbackRequests += 1; completeResponse(req, res); });
    const primaryPort = await listen(primary); const fallbackPort = await listen(fallback);
    t.after(() => closeUpstreams(primary, fallback));
    const proxy = await createProxy(t, [
      { id: "primary", name: "取消首选", port: primaryPort },
      { id: "fallback", name: "不应调用", port: fallbackPort },
    ], { streamingFirstByteTimeoutMs: 1000, streamingIdleTimeoutMs: 1000, nonStreamingTimeoutMs: 1000 });
    const controller = new AbortController();
    const pending = postResponse(proxy, { signal: controller.signal, stream: !phase.includes("buffer") }).catch((error) => error);
    await waitUntil(() => primaryRequests === 1); await pause(30);
    const cancelledAt = Date.now(); controller.abort(); await pending;
    const { status, group } = await waitForDiagnostics(proxy);
    assert.ok(Date.now() - cancelledAt < 500, "取消没有及时释放请求");
    await waitUntil(() => primaryClosed);
    assert.equal(fallbackRequests, 0); assert.equal(primaryRequests, 1);
    const [record] = await waitForUsage(proxy.usagePath);
    assert.equal(record.statusCode, 499); assert.equal(record.failureClass, "client_connection_closed");
    assert.equal(record.providerAttempts.length, 1);
    assert.equal(record.providerAttempts[0].retryable, false);
    assert.equal(record.providerAttempts[0].affectsCircuit, false);
    assert.ok(status.providers.every((provider) => provider.circuit.failedRequests === 0));
    assert.ok(status.recoveryProbes.every((probe) => !probe.running && !probe.scheduledAt));
    assert.equal(group.statistics.streamDiagnostics.transportErrors, 0);
    assert.equal(group.statistics.streamDiagnostics.midStreamDisconnects, 0);
    assert.equal(group.statistics.streamDiagnostics.preOutputFailures, 0);
    const active = await fetch(`${proxy.baseUrl}/api/requests/active`).then((r) => r.json());
    assert.equal(active.active, 0);
  });
}

test("退避等待中的客户端取消会打断定时器，不追加业务重试", async (t) => {
  let requests = 0;
  const upstream = createServer((req, res) => {
    requests += 1; res.writeHead(503); res.end("overloaded");
  });
  const port = await listen(upstream); t.after(() => closeUpstreams(upstream));
  const proxy = await createProxy(t, [{ id: "backoff", name: "退避测试", port }], {
    maxAttempts: 4, preferredProviderMaxAttempts: 4,
    preferredProviderRetryDelayMs: 1600, preferredProviderRetryMaxDelayMs: 1600,
  });
  const controller = new AbortController();
  const pending = postResponse(proxy, { signal: controller.signal }).catch((error) => error);
  await waitUntil(() => requests === 2); await pause(30);
  const cancelledAt = Date.now(); controller.abort(); await pending;
  await waitForDiagnostics(proxy);
  assert.ok(Date.now() - cancelledAt < 500, "仍在等待整个退避定时器");
  assert.equal(requests, 2);
  const [record] = await waitForUsage(proxy.usagePath);
  assert.equal(record.statusCode, 499); assert.equal(record.failureClass, "client_connection_closed");
});

test("管理台取消错误正文读取保留 operator_cancelled 分类且不切换", async (t) => {
  let primaryRequests = 0; let fallbackRequests = 0;
  const primary = createServer((req, res) => {
    primaryRequests += 1; res.writeHead(503); res.write('{"error":"pending');
  });
  const fallback = createServer((req, res) => { fallbackRequests += 1; completeResponse(req, res); });
  const primaryPort = await listen(primary); const fallbackPort = await listen(fallback);
  t.after(() => closeUpstreams(primary, fallback));
  const proxy = await createProxy(t, [
    { id: "primary", name: "管理台取消", port: primaryPort }, { id: "fallback", name: "备用", port: fallbackPort },
  ]);
  const pending = postResponse(proxy);
  await waitUntil(() => primaryRequests === 1);
  const active = await fetch(`${proxy.baseUrl}/api/requests/active`).then((r) => r.json());
  const cancelled = await fetch(`${proxy.baseUrl}/api/requests/${active.requests[0].id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200);
  const response = await pending; assert.equal(response.status, 499); await response.text();
  const [record] = await waitForUsage(proxy.usagePath);
  assert.equal(record.failureClass, "operator_cancelled"); assert.equal(fallbackRequests, 0);
  const { status } = await waitForDiagnostics(proxy);
  assert.ok(status.providers.every((provider) => provider.circuit.failedRequests === 0));
});

for (const [stream, statusCode] of [[true, 503], [true, 400], [false, 503], [false, 400]]) {
  test(`${stream ? "流式" : "非流式"} HTTP ${statusCode} 错误正文停顿超时，保留原状态的重试语义`, async (t) => {
    let primaryClosed = false; let fallbackRequests = 0;
    const primary = createServer((req, res) => {
      res.writeHead(statusCode); res.write('{"error":{"message":"pending');
      res.once("close", () => { primaryClosed = true; });
    });
    const fallback = createServer((req, res) => {
      fallbackRequests += 1;
      if (stream) return completeResponse(req, res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-fallback", status: "completed", model: "stream-test", output: [] }));
    });
    const primaryPort = await listen(primary); const fallbackPort = await listen(fallback);
    t.after(() => closeUpstreams(primary, fallback));
    const proxy = await createProxy(t, [
      { id: "primary", name: "错误正文等待", port: primaryPort }, { id: "fallback", name: "备用", port: fallbackPort },
    ], { streamingIdleTimeoutMs: 150, nonStreamingTimeoutMs: 150 });
    const startedAt = Date.now(); const response = await postResponse(proxy, { stream }); const text = await response.text();
    assert.ok(Date.now() - startedAt < 800); await waitUntil(() => primaryClosed);
    const [record] = await waitForUsage(proxy.usagePath);
    assert.equal(record.providerAttempts[0].statusCode, statusCode);
    assert.match(record.providerAttempts[0].error, /错误正文读取超时/);
    if (statusCode === 503) {
      assert.equal(response.status, 200); assert.equal(fallbackRequests, 1);
      if (stream) assert.match(text, /response\.completed/);
      else assert.equal(JSON.parse(text).status, "completed");
    } else {
      assert.equal(response.status, 400); assert.equal(fallbackRequests, 0); assert.doesNotMatch(text, /response\.completed/);
    }
  });
}

test("错误正文持续滴流也受整段读取时限约束", async (t) => {
  let primaryClosed = false;
  const primary = createServer((req, res) => {
    res.writeHead(503); res.write("pending");
    const timer = setInterval(() => res.write("."), 20);
    res.once("close", () => { clearInterval(timer); primaryClosed = true; });
  });
  const fallback = createServer(completeResponse);
  const primaryPort = await listen(primary); const fallbackPort = await listen(fallback);
  t.after(() => closeUpstreams(primary, fallback));
  const proxy = await createProxy(t, [
    { id: "primary", name: "错误正文滴流", port: primaryPort }, { id: "fallback", name: "备用", port: fallbackPort },
  ], { streamingIdleTimeoutMs: 150 });
  const startedAt = Date.now(); const response = await postResponse(proxy);
  assert.match(await response.text(), /response\.completed/);
  assert.ok(Date.now() - startedAt < 800); await waitUntil(() => primaryClosed);
});

test("错误正文超过上限时终止读取，保留有界诊断并切换", async (t) => {
  let primaryClosed = false;
  const primary = createServer((req, res) => {
    res.writeHead(503); res.write("x".repeat(128 * 1024));
    res.once("close", () => { primaryClosed = true; });
  });
  const fallback = createServer(completeResponse);
  const primaryPort = await listen(primary); const fallbackPort = await listen(fallback);
  t.after(() => closeUpstreams(primary, fallback));
  const proxy = await createProxy(t, [
    { id: "primary", name: "错误正文上限", port: primaryPort }, { id: "fallback", name: "备用", port: fallbackPort },
  ]);
  const response = await postResponse(proxy); assert.match(await response.text(), /response\.completed/);
  await waitUntil(() => primaryClosed);
  const [record] = await waitForUsage(proxy.usagePath);
  assert.match(record.providerAttempts[0].error, /64 KiB 上限/);
  assert.ok(record.providerAttempts[0].error.length < 4200);
});

test("同一供应商的并发请求中，取消一条不会中断另一条", async (t) => {
  let primaryRequests = 0; let cancelledClosed = false;
  const upstream = createServer((req, res) => {
    primaryRequests += 1;
    if (req.headers["x-request-id"] === "cancel-one") {
      res.once("close", () => { cancelledClosed = true; }); return;
    }
    setTimeout(() => completeResponse(req, res), 180);
  });
  const port = await listen(upstream); t.after(() => closeUpstreams(upstream));
  const proxy = await createProxy(t, [{ id: "parallel", name: "并发测试", port }]);
  const controller = new AbortController();
  const cancelled = postResponse(proxy, { signal: controller.signal, requestId: "cancel-one" }).catch((e) => e);
  const continued = postResponse(proxy, { requestId: "continue-one" });
  await waitUntil(() => primaryRequests === 2); controller.abort(); await cancelled;
  const response = await continued; assert.match(await response.text(), /response\.completed/);
  await waitUntil(() => cancelledClosed); await waitForDiagnostics(proxy);
  assert.equal(primaryRequests, 2);
});

test("上传请求体中途取消不会发出任何上游请求", async (t) => {
  let requests = 0;
  const upstream = createServer((req, res) => { requests += 1; completeResponse(req, res); });
  const port = await listen(upstream); t.after(() => closeUpstreams(upstream));
  const proxy = await createProxy(t, [{ id: "upload", name: "上传取消", port }]);
  const request = httpRequest(`${proxy.baseUrl}/v1/responses`, { method: "POST", headers: {
    "content-type": "application/json", "content-length": "9999",
  } });
  request.on("error", () => {}); request.write('{"model":"stream-test",');
  await waitUntil(async () => (await fetch(`${proxy.baseUrl}/api/status`).then((r) => r.json())).activeConnections === 1);
  request.destroy(); await waitForDiagnostics(proxy);
  assert.equal(requests, 0);
  const [record] = await waitForUsage(proxy.usagePath);
  assert.equal(record.statusCode, 499); assert.equal(record.failureClass, "client_connection_closed");
});
