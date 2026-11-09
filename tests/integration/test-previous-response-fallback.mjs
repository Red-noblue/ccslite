/**
 * previous_response_id 粘滞迁移回退测试。
 * 低价供应商无法识别旧响应时，本次请求按顺序回到原供应商，不复制业务请求。
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
      // 服务尚未监听，继续短暂等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`previous_response_id 回退测试服务启动超时：${logs()}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function waitForBusinessRecords(usagePath, minimumCount) {
  for (let index = 0; index < 60; index += 1) {
    try {
      const records = (await readFile(usagePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .filter((record) => !record.endpoint.includes("#provider-test"));
      if (records.length >= minimumCount) return records;
    } catch {
      // usage 日志仍在异步落盘，继续短暂等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("previous_response_id 回退测试 usage 日志写入超时");
}

test("迁移后的旧 response_id 在新供应商不兼容时回退原供应商", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-previous-response-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const priceLabPath = path.join(tempRoot, "price-lab.json");
  let primaryHealthy = false;
  let primaryBusinessRequests = 0;
  let fallbackBusinessRequests = 0;

  const primaryUpstream = createServer(async (req, res) => {
    const body = await readBody(req);
    const request = JSON.parse(body);
    const isProbe = body.includes("请只回复 CCOK");
    if (!isProbe) primaryBusinessRequests += 1;
    if (!primaryHealthy && !isProbe) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "首选供应商暂时不可用" } }));
      return;
    }
    if (!isProbe && request.previous_response_id === "resp-fallback") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          code: "invalid_request_error",
          param: "previous_response_id",
          message: "previous_response_id resp-fallback does not belong to this provider",
        },
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "resp-primary",
      model: request.model,
      output: [{ type: "message", content: [{ type: "output_text", text: isProbe ? "CCOK" : "primary" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
  const fallbackUpstream = createServer(async (req, res) => {
    const body = await readBody(req);
    const request = JSON.parse(body);
    fallbackBusinessRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "resp-fallback",
      model: request.model,
      output: [{ type: "message", content: [{ type: "output_text", text: "fallback" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
  const primaryPort = await listen(primaryUpstream);
  const fallbackPort = await listen(fallbackUpstream);
  const probe = createServer();
  const proxyPort = await listen(probe);
  await close(probe);
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
      providerMaxAttempts: 1,
      circuit: {
        failureThreshold: 10,
        successThreshold: 1,
        openTimeoutMs: 60_000,
        errorRateThreshold: 1,
        minRequests: 100,
      },
    },
    providers: [
      {
        id: "primary",
        name: "低价首选供应商",
        baseUrl: `http://127.0.0.1:${primaryPort}`,
        apiKey: "primary-key",
        routingEnabled: true,
        sortIndex: 1,
      },
      {
        id: "fallback",
        name: "原响应供应商",
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
      LITE_CCSWITCH_PRICE_LAB: priceLabPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForServer(`${baseUrl}/api/status`, () => logs);
  const first = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": "fallback-session" },
    body: JSON.stringify({ model: "gpt-5.6-terra", input: "第一次", stream: false }),
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-lite-ccswitch-provider-name"), encodeURIComponent("原响应供应商"));
  await first.arrayBuffer();
  assert.equal(fallbackBusinessRequests, 1);

  primaryHealthy = true;
  const recovery = await (await fetch(`${baseUrl}/api/providers/primary/test`, { method: "POST" })).json();
  assert.equal(recovery.ok, true);
  assert.equal(recovery.stickyMigrations, 1);

  const migrated = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-terra",
      previous_response_id: "resp-fallback",
      input: "继续对话",
      stream: false,
    }),
  });
  assert.equal(migrated.status, 200);
  assert.equal(migrated.headers.get("x-lite-ccswitch-provider-name"), encodeURIComponent("原响应供应商"));
  await migrated.arrayBuffer();
  assert.equal(primaryBusinessRequests, 2);
  assert.equal(fallbackBusinessRequests, 2);

  const records = await waitForBusinessRecords(usagePath, 2);
  assert.deepEqual(records.at(-1).providerAttempts.map((attempt) => ({
    providerId: attempt.providerId,
    failureClass: attempt.failureClass,
    affectsCircuit: attempt.affectsCircuit,
  })), [
    { providerId: "primary", failureClass: "response_context_incompatible", affectsCircuit: false },
    { providerId: "fallback", failureClass: "", affectsCircuit: true },
  ]);
});
