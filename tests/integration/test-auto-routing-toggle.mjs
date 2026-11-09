/**
 * “参与自动路由”开关集成测试。
 * 验证旧配置迁移、自动路由筛选、手动检测和单供应商显式选择互不干扰。
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

function createSuccessfulUpstream(onRequest) {
  return createServer((req, res) => {
    onRequest();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: "gpt-5.6-luna",
      output: [{ type: "message", content: [{ type: "output_text", text: "CCOK" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
}

test("合并开关只影响自动路由，关闭项仍可手动使用", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-auto-routing-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  let activeRequests = 0;
  let inactiveRequests = 0;
  const activeUpstream = createSuccessfulUpstream(() => { activeRequests += 1; });
  const inactiveUpstream = createSuccessfulUpstream(() => { inactiveRequests += 1; });
  const activePort = await listen(activeUpstream);
  const inactivePort = await listen(inactiveUpstream);
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
    await close(activeUpstream);
    await close(inactiveUpstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: true,
      currentProviderId: "missing-provider",
      maxAttempts: 2,
    },
    providers: [
      {
        id: "inactive",
        name: "旧配置关闭项",
        baseUrl: `http://127.0.0.1:${inactivePort}`,
        apiKey: "inactive-key",
        enabled: true,
        inFailoverQueue: false,
        sortIndex: 1,
      },
      {
        id: "active",
        name: "旧配置开启项",
        baseUrl: `http://127.0.0.1:${activePort}`,
        apiKey: "active-key",
        enabled: true,
        inFailoverQueue: true,
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxyProcess.stdout.on("data", (chunk) => { childLogs += chunk.toString(); });
  proxyProcess.stderr.on("data", (chunk) => { childLogs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForServer(`${baseUrl}/api/status`, () => childLogs);

  const repairedConfig = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(repairedConfig.proxy.currentProviderId, "active");
  assert.equal(repairedConfig.proxy.manualProviderId, "active");
  const providers = await (await fetch(`${baseUrl}/api/providers`)).json();
  const inactive = providers.find((provider) => provider.id === "inactive");
  const active = providers.find((provider) => provider.id === "active");
  assert.equal(inactive.routingEnabled, false);
  assert.equal(inactive.enabled, false);
  assert.equal(inactive.inFailoverQueue, false);
  assert.equal(active.routingEnabled, true);

  const automaticResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "test", stream: false }),
  });
  assert.equal(automaticResponse.status, 200);
  assert.equal(activeRequests, 1);
  assert.equal(inactiveRequests, 0);
  const statusAfterRequest = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(statusAfterRequest.totalRequests, 1);
  assert.equal(statusAfterRequest.currentProviderId, "active");
  assert.equal(statusAfterRequest.currentProviderName, "旧配置开启项");

  const manualTestResponse = await fetch(`${baseUrl}/api/providers/inactive/test`, { method: "POST" });
  assert.equal(manualTestResponse.status, 200);
  assert.equal((await manualTestResponse.json()).ok, true);
  assert.equal(inactiveRequests, 1);

  const cycleResponse = await fetch(`${baseUrl}/api/connectivity/test`, { method: "POST" });
  assert.equal(cycleResponse.status, 200);
  const cycle = await cycleResponse.json();
  assert.deepEqual(cycle.results.map((result) => result.providerId), ["active"]);
  assert.equal(activeRequests, 2);
  assert.equal(inactiveRequests, 1);

  const disableResponse = await fetch(`${baseUrl}/api/providers/active`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ routingEnabled: false }),
  });
  assert.equal(disableResponse.status, 200);
  const disabled = await disableResponse.json();
  assert.equal(disabled.routingEnabled, false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.inFailoverQueue, false);

  const unavailableResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "test", stream: false }),
  });
  assert.equal(unavailableResponse.status, 503);
  const unavailable = await unavailableResponse.json();
  assert.equal(unavailable.error.type, "no_auto_routing_provider");
  assert.match(unavailable.error.message, /参与自动路由/);
  assert.equal(activeRequests, 2);
  assert.equal(inactiveRequests, 1);

  await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proxy: { autoFailoverEnabled: false } }),
  });
  await fetch(`${baseUrl}/api/providers/inactive/select`, { method: "POST" });
  const manualResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "test", stream: false }),
  });
  assert.equal(manualResponse.status, 200);
  assert.equal(inactiveRequests, 2);
});
