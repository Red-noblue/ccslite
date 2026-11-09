/**
 * 优雅重启 SSE 集成测试。
 * 验证首次 SIGTERM 不会关闭等待上游下一段数据的活动流。
 * 测试仅使用本机伪上游和临时目录，不访问真实供应商。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
  for (let index = 0; index < 60; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 服务尚未完成启动，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`服务启动超时：${logs()}`);
}

test("优雅重启会等待活动 SSE 收到 response.completed", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-graceful-sse-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const upstream = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    setTimeout(() => {
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n');
      res.write('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    }, 500);
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await reservePort();
  let childLogs = "";
  let child = null;

  t.after(async () => {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    await close(upstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: false,
      currentProviderId: "stream",
      streamingFirstByteTimeoutMs: 5000,
      streamingIdleTimeoutMs: 5000,
    },
    providers: [{
      id: "stream",
      name: "SSE 测试供应商",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "test-key",
      enabled: true,
      inFailoverQueue: true,
      sortIndex: 1,
    }],
    connectivityTest: { periodicIntervalMs: null },
  }, null, 2));

  child = spawn(process.execPath, [path.join(TOOL_ROOT, "server.js")], {
    cwd: TOOL_ROOT,
    env: {
      ...process.env,
      LITE_CCSWITCH_HOST: "127.0.0.1",
      LITE_CCSWITCH_PORT: String(proxyPort),
      LITE_CCSWITCH_CONFIG: configPath,
      LITE_CCSWITCH_USAGE: usagePath,
      LITE_CCSWITCH_SHUTDOWN_GRACE_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { childLogs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { childLogs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForServer(`${baseUrl}/api/status`, () => childLogs);
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "test", stream: true }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  child.kill("SIGTERM");

  const chunks = [Buffer.from(first.value).toString("utf8")];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(Buffer.from(next.value).toString("utf8"));
  }
  const body = chunks.join("");
  assert.match(body, /response\.completed/);
  const exitResult = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2500)),
  ]);
  assert.equal(exitResult, true, `优雅关闭未在宽限期内结束：${childLogs}`);
});
