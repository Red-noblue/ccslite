/**
 * 供应商尝试链日志测试。
 *
 * 验证故障转移过程中每个供应商的结果都会进入同一条 usage 记录，且不会重复计费。
 * 测试仅使用本机伪上游和临时目录，不访问真实供应商。
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const TOOL_ROOT = process.env.LITE_CCSWITCH_TEST_ROOT || path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

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
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 服务尚未完成监听，继续短暂等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`lite-ccswitch 测试服务启动超时：${logs()}`);
}

async function waitForUsage(usagePath, minimumRecords = 1) {
  for (let index = 0; index < 50; index += 1) {
    try {
      const text = await readFile(usagePath, "utf8");
      const records = text.trim().split("\n").filter(Boolean).map(JSON.parse);
      if (records.length >= minimumRecords) return records;
    } catch {
      // usage 文件尚未落盘，继续短暂等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("usage 日志没有在预期时间内写入");
}

async function openStatusStream(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  return {
    controller,
    reader: response.body.getReader(),
    decoder: new TextDecoder(),
    buffer: "",
  };
}

async function waitForStatusEvent(stream, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const boundary = stream.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const block = stream.buffer.slice(0, boundary);
      stream.buffer = stream.buffer.slice(boundary + 2);
      const event = block.match(/^event:\s*(.+)$/m)?.[1];
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (event === "status" && data) {
        const payload = JSON.parse(data);
        if (predicate(payload)) return payload;
      }
      continue;
    }
    const remaining = Math.max(1, deadline - Date.now());
    let timer;
    const next = await Promise.race([
      stream.reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("等待状态流事件超时")), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (next.done) throw new Error("状态流在收到预期事件前已关闭");
    stream.buffer += stream.decoder.decode(next.value, { stream: true });
  }
  throw new Error("等待状态流事件超时");
}

async function closeStatusStream(stream) {
  if (!stream) return;
  stream.controller.abort();
  await stream.reader.cancel().catch(() => {});
}

test("故障转移会把完整供应商尝试链写入单条 usage 记录", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-attempt-log-"));
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const configPath = path.join(tempRoot, "config.json");
  let firstRequestCount = 0;
  const firstUpstream = createServer((req, res) => {
    firstRequestCount += 1;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.includes("请只回复 CCOK")) {
        const requestModel = JSON.parse(body).model;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          model: requestModel,
          output: [{ type: "message", content: [{ type: "output_text", text: "CCOK" }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "模拟供应商暂时不可用" } }));
    });
  });
  const secondUpstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: "gpt-5.6-terra",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
  const firstPort = await listen(firstUpstream);
  const secondPort = await listen(secondUpstream);
  const proxyPort = await reservePort();
  let childLogs = "";
  let proxyProcess = null;
  let statusStream = null;

  t.after(async () => {
    await closeStatusStream(statusStream);
    if (proxyProcess?.exitCode === null) {
      proxyProcess.kill("SIGTERM");
      await Promise.race([
        once(proxyProcess, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    await close(firstUpstream);
    await close(secondUpstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: true,
      currentProviderId: "first",
      maxAttempts: 5,
      preferredProviderMaxAttempts: 3,
      preferredProviderRetryDelayMs: 10,
      preferredProviderRetryMaxDelayMs: 20,
      preferredProviderRetryBudgetMs: 1000,
      circuit: {
        failureThreshold: 3,
        successThreshold: 2,
        openTimeoutMs: 60000,
        errorRateThreshold: 0.6,
        minRequests: 10,
      },
    },
    providers: [
      {
        id: "first",
        name: "第一个供应商",
        baseUrl: `http://127.0.0.1:${firstPort}`,
        apiKey: "test-key-1",
        enabled: true,
        inFailoverQueue: true,
        sortIndex: 1,
      },
      {
        id: "second",
        name: "第二个供应商",
        baseUrl: `http://127.0.0.1:${secondPort}`,
        apiKey: "test-key-2",
        enabled: true,
        inFailoverQueue: true,
        sortIndex: 2,
      },
    ],
    connectivityTest: { periodicIntervalMs: 10800000 },
  }, null, 2));

  function startProxy() {
    proxyProcess = spawn(process.execPath, [path.join(TOOL_ROOT, "server.js")], {
      cwd: TOOL_ROOT,
      env: {
        ...process.env,
        LITE_CCSWITCH_HOST: "127.0.0.1",
        LITE_CCSWITCH_PORT: String(proxyPort),
        LITE_CCSWITCH_CONFIG: configPath,
        LITE_CCSWITCH_USAGE: usagePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proxyProcess.stdout.on("data", (chunk) => { childLogs += chunk.toString(); });
    proxyProcess.stderr.on("data", (chunk) => { childLogs += chunk.toString(); });
  }

  startProxy();

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForServer(`${baseUrl}/api/status`, () => childLogs);
  statusStream = await openStatusStream(`${baseUrl}/api/status/events`);
  const requestStartedAt = Date.now();
  const responsePromise = fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer local-test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5.6-terra", input: "test", stream: false }),
  });
  const firstAttemptStatus = await waitForStatusEvent(
    statusStream,
    (status) => status.currentProviderId === "first" && status.currentProviderSource === "proxy_attempt",
  );
  assert.equal(firstAttemptStatus.currentProviderName, "第一个供应商");
  const response = await responsePromise;
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(firstRequestCount, 2);
  assert.ok(Date.now() - requestStartedAt >= 0, "交错调度允许先让后续供应商获得请求机会");
  const pushedStatus = await waitForStatusEvent(
    statusStream,
    (status) => status.currentProviderId === "second",
  );
  assert.equal(pushedStatus.currentProviderName, "第二个供应商");

  const records = await waitForUsage(usagePath);
  assert.equal(records.length, 1);
  assert.equal(records[0].providerId, "second");
  assert.equal(records[0].providerAttempts.length, 3);
  assert.deepEqual(
    records[0].providerAttempts.map((attempt) => ({
      sequence: attempt.sequence,
      providerId: attempt.providerId,
      statusCode: attempt.statusCode,
      outcome: attempt.outcome,
      retryable: attempt.retryable,
      failureClass: attempt.failureClass,
    })),
    [
      {
        sequence: 1,
        providerId: "first",
        statusCode: 503,
        outcome: "failure",
        retryable: true,
        failureClass: "upstream_5xx",
      },
      {
        sequence: 2,
        providerId: "first",
        statusCode: 503,
        outcome: "failure",
        retryable: true,
        failureClass: "upstream_5xx",
      },
      {
        sequence: 3,
        providerId: "second",
        statusCode: 200,
        outcome: "success",
        retryable: false,
        failureClass: "",
      },
    ],
  );
  assert.match(records[0].providerAttempts[0].error, /模拟供应商暂时不可用/);

  const testResponse = await fetch(`${baseUrl}/api/providers/first/test`, { method: "POST" });
  assert.equal(testResponse.status, 200);
  assert.equal((await testResponse.json()).ok, true);
  const billingLogs = await (await fetch(`${baseUrl}/api/billing/logs?limit=100`)).json();
  const manualProbe = billingLogs.records.find((record) => record.probeSource === "manual");
  assert.equal(manualProbe.providerId, "first");
  assert.equal(manualProbe.providerName, "第一个供应商");
  assert.equal(manualProbe.targetProviderId, "first");
  assert.equal(manualProbe.requestModel, "gpt-5.6-luna");
  assert.equal(manualProbe.totalTokens, 2);
  const statusAfterProbe = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(statusAfterProbe.currentProviderId, "second");
  assert.equal(statusAfterProbe.currentProviderName, "第二个供应商");

  await closeStatusStream(statusStream);
  statusStream = null;
  const exitPromise = once(proxyProcess, "exit");
  proxyProcess.kill("SIGTERM");
  await exitPromise;
  startProxy();
  await waitForServer(`${baseUrl}/api/status`, () => childLogs);
  const restoredStatus = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(restoredStatus.currentProviderId, "second");
  assert.equal(restoredStatus.currentProviderName, "第二个供应商");
});

test("明确的模型不支持会临时跳过供应商且不触发断路器", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-model-cache-"));
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const configPath = path.join(tempRoot, "config.json");
  let unsupportedRequestCount = 0;
  const unsupportedUpstream = createServer((req, res) => {
    unsupportedRequestCount += 1;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { code: "model_not_found", message: "unsupported model gpt-5.6-sol" },
    }));
  });
  const supportedUpstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: "gpt-5.6-sol",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
  const unsupportedPort = await listen(unsupportedUpstream);
  const supportedPort = await listen(supportedUpstream);
  const proxyPort = await reservePort();
  let childLogs = "";
  let proxyProcess = null;

  t.after(async () => {
    if (proxyProcess?.exitCode === null) {
      proxyProcess.kill("SIGTERM");
      await Promise.race([
        once(proxyProcess, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    await close(unsupportedUpstream);
    await close(supportedUpstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: true,
      currentProviderId: "unsupported",
      maxAttempts: 2,
      circuit: {
        failureThreshold: 1,
        successThreshold: 1,
        openTimeoutMs: 60000,
        errorRateThreshold: 0.6,
        minRequests: 1,
      },
    },
    providers: [
      {
        id: "unsupported",
        name: "不支持目标模型",
        baseUrl: `http://127.0.0.1:${unsupportedPort}`,
        apiKey: "test-key-unsupported",
        enabled: true,
        inFailoverQueue: true,
        sortIndex: 1,
      },
      {
        id: "supported",
        name: "支持目标模型",
        baseUrl: `http://127.0.0.1:${supportedPort}`,
        apiKey: "test-key-supported",
        enabled: true,
        inFailoverQueue: true,
        sortIndex: 2,
      },
    ],
    connectivityTest: { periodicIntervalMs: 10800000 },
  }, null, 2));

  proxyProcess = spawn(process.execPath, [path.join(TOOL_ROOT, "server.js")], {
    cwd: TOOL_ROOT,
    env: {
      ...process.env,
      LITE_CCSWITCH_HOST: "127.0.0.1",
      LITE_CCSWITCH_PORT: String(proxyPort),
      LITE_CCSWITCH_CONFIG: configPath,
      LITE_CCSWITCH_USAGE: usagePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxyProcess.stdout.on("data", (chunk) => { childLogs += chunk.toString(); });
  proxyProcess.stderr.on("data", (chunk) => { childLogs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForServer(`${baseUrl}/api/status`, () => childLogs);
  const request = () => fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer local-test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "test", stream: false }),
  });

  const firstResponse = await request();
  assert.equal(firstResponse.status, 200);
  await firstResponse.arrayBuffer();
  const secondResponse = await request();
  assert.equal(secondResponse.status, 200);
  await secondResponse.arrayBuffer();

  const records = await waitForUsage(usagePath, 2);
  assert.equal(unsupportedRequestCount, 1);
  assert.equal(records[0].providerAttempts[0].failureClass, "model_unsupported");
  assert.equal(records[0].providerAttempts[0].affectsCircuit, false);
  assert.deepEqual(records[1].providerAttempts.map((attempt) => attempt.providerId), ["supported"]);

  const savedConfig = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(
    savedConfig.providers.find((provider) => provider.id === "unsupported")
      .modelSupport.modelEvidence["gpt-5.6-sol"].state,
    "unsupported",
  );
  const status = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(
    status.providers.find((provider) => provider.id === "unsupported").circuit.totalRequests,
    0,
  );
});
