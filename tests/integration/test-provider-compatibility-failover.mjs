/**
 * 已知供应商差异错误故障转移测试。
 * 仅精确匹配 parallel_tool_calls 兼容性 400 和已观察到的请求大小限制 413；
 * 其他普通 4xx 仍保持不可重试。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPATIBILITY_MESSAGE =
  "X-OpenAI-Internal-Codex-Responses-Lite requires `parallel_tool_calls` to be false.";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
  });
}

async function waitForServer(url) {
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 测试服务尚未监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("兼容性故障转移测试服务启动超时");
}

async function waitForUsageRecords(usagePath, minimumRecords) {
  for (let index = 0; index < 50; index += 1) {
    try {
      const records = (await readFile(usagePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      if (records.length >= minimumRecords) return records;
    } catch {
      // usage 日志尚未落盘，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("兼容性故障转移 usage 日志写入超时");
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

test("精确的供应商差异错误会转移到下一个供应商", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-compatibility-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const diagnosticsPath = path.join(tempRoot, "413-diagnostics.jsonl");
  const firstUpstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.input === "payload-limit") {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Request payload is too large",
          type: "invalid_request_error",
        },
      }));
      return;
    }
    if (request.input === "other-413") {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "请求参数中的附件格式无效",
          type: "invalid_request_error",
        },
      }));
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "unsupported_value",
        param: "parallel_tool_calls",
        message: COMPATIBILITY_MESSAGE,
      },
    }));
  });
  const secondUpstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: "gpt-5.6-sol",
      output: [{ type: "message", content: [{ type: "output_text", text: "CCOK" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
  const firstPort = await listen(firstUpstream);
  const secondPort = await listen(secondUpstream);
  const portProbe = createServer();
  const proxyPort = await listen(portProbe);
  await close(portProbe);
  let child = null;
  let childLogs = "";

  t.after(async () => {
    await stopProcess(child);
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
        name: "兼容性失败供应商",
        baseUrl: `http://127.0.0.1:${firstPort}`,
        apiKey: "first-key",
        enabled: true,
        inFailoverQueue: true,
        sortIndex: 1,
      },
      {
        id: "second",
        name: "后备供应商",
        baseUrl: `http://127.0.0.1:${secondPort}`,
        apiKey: "second-key",
        enabled: true,
        inFailoverQueue: true,
        sortIndex: 2,
      },
    ],
    connectivityTest: { periodicIntervalMs: "never", candidateModels: ["gpt-5.6-sol"] },
  }, null, 2));

  child = spawn(process.execPath, [path.join(TOOL_ROOT, "server.js")], {
    cwd: TOOL_ROOT,
    env: {
      ...process.env,
      LITE_CCSWITCH_HOST: "127.0.0.1",
      LITE_CCSWITCH_PORT: String(proxyPort),
      LITE_CCSWITCH_CONFIG: configPath,
      LITE_CCSWITCH_USAGE: usagePath,
      LITE_CCSWITCH_413_LOG: diagnosticsPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { childLogs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { childLogs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  try {
    await waitForServer(`${baseUrl}/api/status`);
  } catch (error) {
    throw new Error(`${error.message}: ${childLogs}`);
  }
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-session-id": "compatibility-session-1",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "test", stream: false }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-name"), encodeURIComponent("后备供应商"));
  await response.arrayBuffer();

  const firstRecords = await waitForUsageRecords(usagePath, 1);
  assert.equal(firstRecords[0].providerId, "second");
  assert.equal(firstRecords[0].providerAttempts[0].providerId, "first");
  assert.equal(firstRecords[0].providerAttempts[0].failureClass, "provider_compatibility");
  assert.equal(firstRecords[0].providerAttempts[0].retryable, true);
  assert.equal(firstRecords[0].providerAttempts[0].affectsCircuit, false);
  assert.equal(firstRecords[0].providerAttempts[1].providerId, "second");

  const armResponse = await fetch(`${baseUrl}/api/diagnostics/413/arm`, { method: "POST" });
  assert.equal(armResponse.status, 200);

  const payloadLimitResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-session-id": "compatibility-session-2",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "payload-limit", stream: false }),
  });
  assert.equal(payloadLimitResponse.status, 200);
  assert.equal(
    payloadLimitResponse.headers.get("x-lite-ccswitch-provider-name"),
    encodeURIComponent("后备供应商"),
  );
  await payloadLimitResponse.arrayBuffer();

  const records = await waitForUsageRecords(usagePath, 2);
  const payloadLimitRecord = records[1];
  assert.equal(payloadLimitRecord.providerId, "second");
  assert.equal(payloadLimitRecord.providerAttempts.length, 2);
  assert.equal(payloadLimitRecord.providerAttempts[0].providerId, "first");
  assert.equal(payloadLimitRecord.providerAttempts[0].statusCode, 413);
  assert.equal(payloadLimitRecord.providerAttempts[0].failureClass, "provider_payload_limit");
  assert.equal(payloadLimitRecord.providerAttempts[0].retryable, true);
  assert.equal(payloadLimitRecord.providerAttempts[0].affectsCircuit, false);
  assert.equal(payloadLimitRecord.providerAttempts[0].retryDelayMs, 0);
  assert.equal(payloadLimitRecord.providerAttempts[1].providerId, "second");

  let diagnosticRecords = [];
  for (let index = 0; index < 50; index += 1) {
    try {
      diagnosticRecords = (await readFile(diagnosticsPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      if (diagnosticRecords.length > 0) break;
    } catch {
      // 后台诊断尚未完成，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(diagnosticRecords.length, 1);
  assert.equal(diagnosticRecords[0].requestBytes > 0, true);
  assert.equal(diagnosticRecords[0].steps.filter((step) => step.type === "original_payload_retry").length, 2);
  assert.equal(diagnosticRecords[0].steps.filter((step) => step.type === "ccok").length, 2);
  assert.equal((await readFile(usagePath, "utf8")).trim().split("\n").filter(Boolean).length, 2);

  const unrelated413Response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "other-413", stream: false }),
  });
  assert.equal(unrelated413Response.status, 413);
  await unrelated413Response.arrayBuffer();

  const finalRecords = await waitForUsageRecords(usagePath, 3);
  const unrelated413Record = finalRecords[2];
  assert.equal(unrelated413Record.providerId, "first");
  assert.equal(unrelated413Record.providerAttempts.length, 1);
  assert.equal(unrelated413Record.providerAttempts[0].providerId, "first");
  assert.equal(unrelated413Record.providerAttempts[0].retryable, false);
});
