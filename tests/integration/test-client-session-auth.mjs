/**
 * 客户端会话认证供应商的集成测试。
 * 验证真实请求成功后，后台连通性测试能仅从内存复用会话头，并按结果更新路由健康。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SESSION_BEARER = "Bearer session-for-test-only";
const SESSION_ACCOUNT_ID = "account-for-test-only";

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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendCcok(res, { stream = false } = {}) {
  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"CCOK"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      "",
    ].join("\n"));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    model: "gpt-5.6-luna",
    output: [{ type: "message", content: [{ type: "output_text", text: "CCOK" }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }));
}

async function waitForServer(url, logs) {
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 服务尚未监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`lite-ccswitch 测试服务启动超时：${logs()}`);
}

test("客户端会话供应商会用真实请求上下文完成主动连通性测试", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-client-session-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const priceLabPath = path.join(tempRoot, "price-lab.json");
  let allowProbe = true;
  let businessRequests = 0;
  let probeRequests = 0;
  let probeInputIsList = false;
  let probeStoreIsFalse = false;
  let probeStreamIsEnabled = false;
  let probeMatchesCodexRequestShape = false;
  const upstream = createServer(async (req, res) => {
    const body = await readBody(req);
    const isProbe = body.includes("请只回复 CCOK");
    if (
      req.headers.authorization !== SESSION_BEARER ||
      req.headers["chatgpt-account-id"] !== SESSION_ACCOUNT_ID
    ) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "缺少有效客户端会话" } }));
      return;
    }
    if (isProbe) {
      probeRequests += 1;
      const probePayload = JSON.parse(body);
      probeInputIsList = Array.isArray(probePayload.input);
      probeStoreIsFalse = probePayload.store === false;
      probeStreamIsEnabled = probePayload.stream === true;
      probeMatchesCodexRequestShape =
        !Object.hasOwn(probePayload, "max_output_tokens") &&
        JSON.stringify(probePayload.include) === JSON.stringify(["reasoning.encrypted_content"]) &&
        probePayload.instructions === "" &&
        Array.isArray(probePayload.tools) && probePayload.tools.length === 0 &&
        probePayload.parallel_tool_calls === false;
      if (!allowProbe) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "模拟上游不可用" } }));
        return;
      }
    } else {
      businessRequests += 1;
    }
    sendCcok(res, { stream: isProbe });
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await reservePort();
  let proxyProcess = null;
  let proxyLogs = "";

  t.after(async () => {
    if (proxyProcess?.exitCode === null) {
      proxyProcess.kill("SIGTERM");
      await Promise.race([
        once(proxyProcess, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    await close(upstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: true,
      maxAttempts: 1,
      circuit: {
        failureThreshold: 1,
        successThreshold: 1,
        openTimeoutMs: 600_000,
        errorRateThreshold: 1,
        minRequests: 100,
      },
    },
    providers: [{
      id: "session-upstream",
      name: "会话认证中转",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "static-key-must-not-be-used",
      authMode: "client_session",
      sessionHeaders: ["authorization", "chatgpt-account-id"],
      sessionTtlMs: 900_000,
      routingEnabled: true,
      sortIndex: 1,
    }],
    connectivityTest: {
      candidateModels: ["gpt-5.6-luna"],
      periodicIntervalMs: null,
    },
  }, null, 2));

  proxyProcess = spawn(process.execPath, [path.join(TOOL_ROOT, "server.js")], {
    cwd: TOOL_ROOT,
    env: {
      ...process.env,
      LITE_CCSWITCH_HOST: "127.0.0.1",
      LITE_CCSWITCH_PORT: String(proxyPort),
      LITE_CCSWITCH_CONFIG: configPath,
      LITE_CCSWITCH_USAGE: usagePath,
      LITE_CCSWITCH_PRICE_LAB: priceLabPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxyProcess.stdout.on("data", (chunk) => { proxyLogs += chunk.toString(); });
  proxyProcess.stderr.on("data", (chunk) => { proxyLogs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForServer(`${baseUrl}/api/status`, () => proxyLogs);

  const beforeSession = await (await fetch(`${baseUrl}/api/connectivity/test`, { method: "POST" })).json();
  const waiting = beforeSession.results[0];
  assert.equal(waiting.ok, false);
  assert.equal(waiting.routingEffect, "awaiting_session");
  assert.equal(probeRequests, 0);
  let status = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(status.providers[0].circuit.state, "closed");

  const businessResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: SESSION_BEARER,
      "chatgpt-account-id": SESSION_ACCOUNT_ID,
    },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "真实业务请求", stream: false }),
  });
  assert.equal(businessResponse.status, 200);
  await businessResponse.arrayBuffer();
  assert.equal(businessRequests, 1);

  const afterSession = await (await fetch(`${baseUrl}/api/connectivity/test`, { method: "POST" })).json();
  const recovered = afterSession.results[0];
  assert.equal(recovered.ok, true);
  assert.equal(recovered.routingEffect, "recovered");
  assert.equal(probeRequests, 1);
  assert.equal(probeInputIsList, true);
  assert.equal(probeStoreIsFalse, true);
  assert.equal(probeStreamIsEnabled, true);
  assert.equal(probeMatchesCodexRequestShape, true);

  allowProbe = false;
  const failedProbe = await (await fetch(`${baseUrl}/api/connectivity/test`, { method: "POST" })).json();
  assert.equal(failedProbe.results[0].routingEffect, "temporarily_skipped");
  status = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(status.providers[0].circuit.state, "open");

  const savedConfig = await readFile(configPath, "utf8");
  const savedUsage = await readFile(usagePath, "utf8");
  assert.equal(savedConfig.includes(SESSION_BEARER), false);
  assert.equal(savedConfig.includes(SESSION_ACCOUNT_ID), false);
  assert.equal(savedUsage.includes(SESSION_BEARER), false);
  assert.equal(savedUsage.includes(SESSION_ACCOUNT_ID), false);
});
