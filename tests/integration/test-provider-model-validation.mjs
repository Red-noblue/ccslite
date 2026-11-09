/**
 * CCOK 实际响应模型校验集成测试。
 * 请求高阶模型却被上游降级返回其他模型时，不能误判为高阶模型可用。
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
  throw new Error(`模型校验测试服务启动超时：${logs()}`);
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

test("CCOK 返回降级模型时不会确认请求模型，随后可尝试下一个模型", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-model-validation-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const priceLabPath = path.join(tempRoot, "price-lab.json");
  const upstream = createServer(async (req, res) => {
    const request = JSON.parse(await readBody(req));
    const responseModel = request.model === "gpt-6-astra"
      ? "gpt-5.6-luna"
      : request.model;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: responseModel,
      output: [{ type: "message", content: [{ type: "output_text", text: "CCOK" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const probe = createServer();
  const proxyPort = await listen(probe);
  await close(probe);
  let child = null;
  let logs = "";

  t.after(async () => {
    await stopProcess(child);
    await close(upstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: { autoFailoverEnabled: true },
    providers: [{
      id: "model-fallback",
      name: "模型降级测试供应商",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "test-key",
      routingEnabled: true,
      sortIndex: 1,
    }],
    connectivityTest: {
      candidateModels: ["gpt-6-astra", "gpt-5.6-luna"],
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
  const response = await fetch(`${baseUrl}/api/providers/model-fallback/test`, { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.model, "gpt-5.6-luna");
  assert.equal(result.responseModel, "gpt-5.6-luna");
  assert.equal(result.routingEffect, "recovered");
  assert.deepEqual(result.attempts.map((attempt) => attempt.model), [
    "gpt-6-astra",
    "gpt-5.6-luna",
  ]);
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[0].failureClass, "model_unsupported");

  const savedConfig = JSON.parse(await readFile(configPath, "utf8"));
  const evidence = savedConfig.providers[0].modelSupport.modelEvidence;
  assert.equal(evidence["gpt-6-astra"].state, "unsupported");
  assert.equal(evidence["gpt-5.6-luna"].state, "supported");
});
