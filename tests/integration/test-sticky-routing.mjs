/**
 * 会话粘滞路由集成测试。
 * 验证同一会话发生故障时切换，恢复后按更高的手动优先级回到首选供应商。
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForServer(url, logs) {
  for (let index = 0; index < 60; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 测试服务尚未监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`粘滞路由测试服务启动超时：${logs()}`);
}

async function waitForRecovery(baseUrl, providerId) {
  let lastProbe = null;
  for (let index = 0; index < 400; index += 1) {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    const probe = status.recoveryProbes?.find((item) => item.providerId === providerId);
    lastProbe = probe || null;
    if (probe?.lastResult?.ok && probe.recoveryConfirmed &&
        probe.confirmedModels?.some((item) => item.model === "gpt-5.6-terra") &&
        !probe.running && !probe.scheduledAt && probe.successStreak === 0) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待供应商 ${providerId} 完成两次恢复探测超时：${JSON.stringify(lastProbe)}`);
}

async function waitForUsageRecords(baseUrl, filePath, count) {
  for (let index = 0; index < 80; index += 1) {
    try {
      // 状态接口会先等待当前用量写队列，确保响应已返回但尚未落盘的尾记录也完成。
      await fetch(`${baseUrl}/api/status`);
      const records = (await readFile(filePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      if (records.length >= count) return records.map(JSON.parse);
    } catch {
      // 用量追加可能尚未完成，继续等待落盘。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test("同一会话故障后切换，恢复后按价格优先级回到首选供应商", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-sticky-integration-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  let primaryHealthy = true;
  let primaryBusinessRequests = 0;
  let primaryProbeRequests = 0;
  let fallbackRequests = 0;

  const primaryUpstream = createServer(async (req, res) => {
    const body = await readBody(req);
    const isProbe = body.includes("请只回复 CCOK");
    if (isProbe) primaryProbeRequests += 1;
    else primaryBusinessRequests += 1;
    if (!primaryHealthy) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "模拟首选供应商故障" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `primary-${primaryBusinessRequests + primaryProbeRequests}`,
      model: "gpt-5.6-terra",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: isProbe ? "CCOK" : "primary" }],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
  const fallbackUpstream = createServer(async (req, res) => {
    await readBody(req);
    fallbackRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `fallback-${fallbackRequests}`,
      model: "gpt-5.6-terra",
      output: [{ type: "message", content: [{ type: "output_text", text: "fallback" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
  const primaryPort = await listen(primaryUpstream);
  const fallbackPort = await listen(fallbackUpstream);
  const proxyPort = await reservePort();
  let child = null;
  let logs = "";

  t.after(async () => {
    await stopProcess(child);
    await close(primaryUpstream);
    await close(fallbackUpstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: true,
      maxAttempts: 3,
      preferredProviderMaxAttempts: 1,
      circuit: {
        failureThreshold: 10,
        successThreshold: 1,
        openTimeoutMs: 60000,
        errorRateThreshold: 1,
        minRequests: 100,
      },
    },
    providers: [
      {
        id: "primary",
        name: "首选供应商",
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
      candidateModels: ["gpt-5.6-terra"],
      periodicIntervalMs: null,
    },
  }, null, 2));

  child = spawn(process.execPath, [path.join(TOOL_ROOT, "server.js")], {
    cwd: TOOL_ROOT,
    env: {
      ...process.env,
      LITE_CCSWITCH_HOST: "127.0.0.1",
      LITE_CCSWITCH_PORT: String(proxyPort),
      LITE_CCSWITCH_CONFIG: configPath,
      LITE_CCSWITCH_USAGE: usagePath,
      LITE_CCSWITCH_RECOVERY_PROBE_INTERVAL_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForServer(`${baseUrl}/api/status`, () => logs);
  const headers = {
    "content-type": "application/json",
    "x-codex-session-id": "sticky-session",
  };
  const request = (input) => fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5.6-terra", input, stream: false }),
  });

  let response = await request("第一次请求");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-name"), encodeURIComponent("首选供应商"));
  await response.arrayBuffer();

  response = await request("第二次请求");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-name"), encodeURIComponent("首选供应商"));
  await response.arrayBuffer();
  assert.equal(primaryBusinessRequests, 2);
  assert.equal(fallbackRequests, 0);

  primaryHealthy = false;
  response = await request("故障切换请求");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-name"), encodeURIComponent("备用供应商"));
  await response.arrayBuffer();
  assert.equal(primaryBusinessRequests, 3);
  assert.equal(fallbackRequests, 1);

  response = await request("尚未确认恢复时保持备用粘滞");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-name"), encodeURIComponent("备用供应商"));
  await response.arrayBuffer();
  assert.equal(primaryBusinessRequests, 3);
  assert.equal(fallbackRequests, 2);

  primaryHealthy = true;
  const status = await waitForRecovery(baseUrl, "primary");
  assert.ok(primaryProbeRequests >= 2);
  response = await request("两次探测确认后迁移到首选供应商");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-name"), encodeURIComponent("首选供应商"));
  await response.arrayBuffer();
  assert.equal(primaryBusinessRequests, 4);
  assert.equal(fallbackRequests, 2);
  assert.equal(status.stickyRouting.entries, 1);

  const records = await waitForUsageRecords(baseUrl, usagePath, 5);
  const businessRecords = records.filter((record) => !record.endpoint.includes("#provider-test"));
  const probeRecords = records.filter((record) => record.endpoint.includes("#provider-test"));
  assert.deepEqual(
    businessRecords.map((record) => record.providerId),
    ["primary", "primary", "fallback", "fallback", "primary"],
  );
  assert.ok(probeRecords.filter((record) => record.statusCode === 200).length >= 2);
  assert.ok(probeRecords.every((record) => record.providerId === "primary"));
  assert.ok(probeRecords.every((record) => record.targetProviderId === "primary"));
});
