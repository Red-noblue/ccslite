/**
 * CCOK 主动连通测试与自动路由联动的集成测试。
 * 验证测试成功可恢复熔断供应商，测试失败可让后续请求暂时跳过它。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

function sendCcok(res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    model: "gpt-5.6-luna",
    output: [{ type: "message", content: [{ type: "output_text", text: "CCOK" }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }));
}

function sendUnavailable(res) {
  res.writeHead(503, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "模拟上游暂不可用" } }));
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

async function waitForProviderCircuit(baseUrl, providerId, expectedState) {
  for (let index = 0; index < 40; index += 1) {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    const provider = status.providers.find((item) => item.id === providerId);
    if (provider?.circuit?.state === expectedState) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待供应商 ${providerId} 断路器状态 ${expectedState} 超时`);
}

test("CCOK 主动测试会恢复成功供应商并避开失败供应商", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-connectivity-routing-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const priceLabPath = path.join(tempRoot, "price-lab.json");
  let primaryHealthy = false;
  let primaryBusinessRequests = 0;
  const primaryUpstream = createServer(async (req, res) => {
    const body = await readBody(req);
    if (!body.includes("请只回复 CCOK")) primaryBusinessRequests += 1;
    if (primaryHealthy) sendCcok(res);
    else sendUnavailable(res);
  });
  const fallbackUpstream = createServer(async (req, res) => {
    await readBody(req);
    sendCcok(res);
  });
  const primaryPort = await listen(primaryUpstream);
  const fallbackPort = await listen(fallbackUpstream);
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
    await close(primaryUpstream);
    await close(fallbackUpstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: true,
      maxAttempts: 2,
      circuit: {
        failureThreshold: 1,
        successThreshold: 1,
        openTimeoutMs: 600_000,
        errorRateThreshold: 1,
        minRequests: 100,
      },
    },
    providers: [
      {
        id: "primary",
        name: "主供应商",
        baseUrl: `http://127.0.0.1:${primaryPort}`,
        apiKey: "primary-key",
        routingEnabled: true,
        sortIndex: 1,
      },
      {
        id: "fallback",
        name: "备用供应商",
        baseUrl: `http://127.0.0.1:${fallbackPort}`,
        apiKey: "fallback-key",
        routingEnabled: true,
        sortIndex: 2,
      },
    ],
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

  const firstRequest = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-session-id": "sticky-session",
    },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "业务请求", stream: false }),
  });
  assert.equal(firstRequest.status, 200);
  await firstRequest.arrayBuffer();
  let status = await waitForProviderCircuit(baseUrl, "primary", "open");

  primaryHealthy = true;
  const recoveryCycle = await (await fetch(`${baseUrl}/api/connectivity/test`, { method: "POST" })).json();
  const recovery = recoveryCycle.results.find((result) => result.providerId === "primary");
  assert.equal(recovery.ok, true);
  assert.equal(recovery.routingEffect, "recovered");
  status = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(status.providers.find((provider) => provider.id === "primary").circuit.state, "closed");

  const recoveredRequest = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-session-id": "sticky-session",
    },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "恢复后的业务请求", stream: false }),
  });
  assert.equal(recoveredRequest.status, 200);
  await recoveredRequest.arrayBuffer();
  // 价格优先：主动探测恢复后，后续请求回到 sortIndex 更小的主供应商。
  assert.equal(primaryBusinessRequests, 2);

  primaryHealthy = false;
  const failureCycle = await (await fetch(`${baseUrl}/api/connectivity/test`, { method: "POST" })).json();
  const failure = failureCycle.results.find((result) => result.providerId === "primary");
  assert.equal(failure.ok, false);
  assert.equal(failure.routingEffect, "temporarily_skipped");
  status = await waitForProviderCircuit(baseUrl, "primary", "open");

  const beforeSkippedRequest = primaryBusinessRequests;
  const skippedRequest = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-session-id": "sticky-session",
    },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "应走备用供应商", stream: false }),
  });
  assert.equal(skippedRequest.status, 200);
  await skippedRequest.arrayBuffer();
  assert.equal(primaryBusinessRequests, beforeSkippedRequest);
});

test("默认路由按 sortIndex 使用普通供应商，不把 cx 账号当成隐藏路由池", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-default-route-order-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const priceLabPath = path.join(tempRoot, "price-lab.json");
  let miaomiaoRequests = 0;
  let cx1Requests = 0;
  const miaomiaoUpstream = createServer(async (req, res) => {
    await readBody(req);
    miaomiaoRequests += 1;
    sendCcok(res);
  });
  const cx1Upstream = createServer(async (req, res) => {
    await readBody(req);
    cx1Requests += 1;
    sendCcok(res);
  });
  const miaomiaoPort = await listen(miaomiaoUpstream);
  const cx1Port = await listen(cx1Upstream);
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
    await close(miaomiaoUpstream);
    await close(cx1Upstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: true,
      maxAttempts: 2,
      currentProviderId: "cx1",
    },
    providers: [
      {
        id: "miaomiao",
        name: "猫猫test1",
        baseUrl: `http://127.0.0.1:${miaomiaoPort}`,
        apiKey: "miaomiao-key",
        routingEnabled: true,
        sortIndex: 2,
      },
      {
        id: "cx1",
        name: "cx1",
        baseUrl: `http://127.0.0.1:${cx1Port}`,
        apiKey: "cx1-key",
        routingEnabled: true,
        sortIndex: 3,
      },
    ],
    connectivityTest: {
      candidateModels: ["gpt-5.6-sol"],
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
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "默认路由优先级", stream: false }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-name"), encodeURIComponent("猫猫test1"));
  await response.arrayBuffer();
  assert.equal(miaomiaoRequests, 1);
  assert.equal(cx1Requests, 0);
});
