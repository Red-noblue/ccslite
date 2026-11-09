/**
 * OAuth 动态认证文件供应商的集成测试。
 * 验证 Lite 不复制客户端 OAuth，并在认证文件变更后让下一次请求使用新会话。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIRST_AUTH = { accessToken: "oauth-access-one", accountId: "oauth-account-one" };
const SECOND_AUTH = { accessToken: "oauth-access-two", accountId: "oauth-account-two" };

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
      if ((await fetch(url)).ok) return;
    } catch {
      // 服务尚未监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`lite-ccswitch 测试服务启动超时：${logs()}`);
}

function authFilePayload(auth) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: auth.accessToken,
      account_id: auth.accountId,
      refresh_token: "refresh-token-not-used-by-lite",
    },
  });
}

test("OAuth 文件模式会动态读取当前会话并允许主动连通性测试", async (t) => {
  const tempHome = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-oauth-file-"));
  const codexHome = path.join(tempHome, ".codex");
  const ccSwitchHome = path.join(tempHome, ".cc-switch");
  const authPath = path.join(codexHome, "auth.json");
  const configPath = path.join(tempHome, "config.json");
  const usagePath = path.join(tempHome, "usage.jsonl");
  const priceLabPath = path.join(tempHome, "price-lab.json");
  await mkdir(codexHome, { recursive: true });
  await mkdir(ccSwitchHome, { recursive: true });
  await writeFile(authPath, authFilePayload(FIRST_AUTH), "utf8");
  await writeFile(path.join(ccSwitchHome, "codex_oauth_auth.json"), "{}", "utf8");

  let expectedAuth = FIRST_AUTH;
  const received = [];
  let probeMatchesCodexShape = false;
  const upstream = createServer(async (req, res) => {
    const body = await readBody(req);
    const isProbe = body.includes("请只回复 CCOK");
    const expectedBearer = `Bearer ${expectedAuth.accessToken}`;
    if (
      req.headers.authorization !== expectedBearer ||
      req.headers["chatgpt-account-id"] !== expectedAuth.accountId
    ) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "未使用当前 OAuth 文件会话" } }));
      return;
    }
    const payload = JSON.parse(body);
    if (isProbe) {
      probeMatchesCodexShape =
        Array.isArray(payload.input) &&
        payload.store === false &&
        payload.stream === true &&
        Array.isArray(payload.tools) &&
        payload.parallel_tool_calls === false;
    }
    received.push({
      isProbe,
      authorization: req.headers.authorization,
      accountId: req.headers["chatgpt-account-id"],
    });
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
    await rm(tempHome, { recursive: true, force: true });
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
      id: "oauth-file-upstream",
      name: "OAuth 文件中转",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "caller-key-must-not-be-forwarded",
      authMode: "oauth_file",
      oauthFilePath: authPath,
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
      LITE_CCSWITCH_OAUTH_FILE_HOME: tempHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxyProcess.stdout.on("data", (chunk) => { proxyLogs += chunk.toString(); });
  proxyProcess.stderr.on("data", (chunk) => { proxyLogs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForServer(`${baseUrl}/api/status`, () => proxyLogs);

  const discovery = await (await fetch(`${baseUrl}/api/oauth-files/discover`)).json();
  assert.equal(discovery.ccSwitchDetected, true);
  assert.equal(discovery.candidates[0].path, authPath);
  assert.equal(discovery.candidates[0].status, "ready", discovery.candidates[0].detail);
  assert.equal(JSON.stringify(discovery).includes(FIRST_AUTH.accessToken), false);
  assert.equal(JSON.stringify(discovery).includes(FIRST_AUTH.accountId), false);

  const probe = await (await fetch(`${baseUrl}/api/connectivity/test`, { method: "POST" })).json();
  assert.equal(probe.results[0].ok, true);
  assert.equal(probeMatchesCodexShape, true);

  const firstBusinessResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer caller-session-must-not-be-forwarded",
      "chatgpt-account-id": "caller-account-must-not-be-forwarded",
    },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "第一次业务请求", stream: false }),
  });
  assert.equal(firstBusinessResponse.status, 200);
  await firstBusinessResponse.arrayBuffer();

  expectedAuth = SECOND_AUTH;
  await writeFile(authPath, authFilePayload(SECOND_AUTH), "utf8");
  const secondBusinessResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer stale-caller-session",
      "chatgpt-account-id": "stale-caller-account",
    },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "第二次业务请求", stream: false }),
  });
  assert.equal(secondBusinessResponse.status, 200);
  await secondBusinessResponse.arrayBuffer();

  assert.deepEqual(received.map((item) => ({
    isProbe: item.isProbe,
    authorization: item.authorization,
    accountId: item.accountId,
  })), [
    { isProbe: true, authorization: `Bearer ${FIRST_AUTH.accessToken}`, accountId: FIRST_AUTH.accountId },
    { isProbe: false, authorization: `Bearer ${FIRST_AUTH.accessToken}`, accountId: FIRST_AUTH.accountId },
    { isProbe: false, authorization: `Bearer ${SECOND_AUTH.accessToken}`, accountId: SECOND_AUTH.accountId },
  ]);

  await writeFile(authPath, JSON.stringify({ tokens: {} }), "utf8");
  const unavailableProbe = await (await fetch(`${baseUrl}/api/connectivity/test`, { method: "POST" })).json();
  assert.equal(unavailableProbe.results[0].routingEffect, "awaiting_oauth_file");
  const statusAfterUnavailableSource = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(statusAfterUnavailableSource.providers[0].circuit.state, "closed");
  assert.equal(received.length, 3);

  const savedConfig = await readFile(configPath, "utf8");
  const savedUsage = await readFile(usagePath, "utf8");
  for (const secret of [
    FIRST_AUTH.accessToken,
    FIRST_AUTH.accountId,
    SECOND_AUTH.accessToken,
    SECOND_AUTH.accountId,
  ]) {
    assert.equal(savedConfig.includes(secret), false);
    assert.equal(savedUsage.includes(secret), false);
  }
  assert.equal(savedConfig.includes(authPath), true);
});
