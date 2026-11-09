/**
 * 持久化、公网鉴权与观测集成验证。
 * 仅启动临时本机服务和模拟上游，不访问真实供应商或生产数据。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "lite-persistence-access-"));
  const requests = [];
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { /* 完整消费请求体。 */ }
    requests.push(req.headers);
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "upstream-id" });
    res.end(JSON.stringify({
      model: "gpt-5.6-sol", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const configPath = path.join(root, "config.json");
  const usagePath = path.join(root, "usage.jsonl");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: { autoFailoverEnabled: false, currentProviderId: "local" },
    providers: [{ id: "local", name: "模拟供应商", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake-key", authMode: "api_key", routingEnabled: true }],
    connectivityTest: { periodicIntervalMs: null },
  }));
  const children = [];
  t.after(async () => {
    for (const child of children) await stop(child);
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, configPath, usagePath, requests, children };
}

async function start(f, overrides = {}) {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...env, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(port),
      LITE_CCSWITCH_CONFIG: f.configPath, LITE_CCSWITCH_USAGE: f.usagePath,
      LITE_CCSWITCH_PRICE_LAB: path.join(f.root, "price-lab.json"), ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  f.children.push(child);
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务启动失败：${logs}`);
    try {
      const response = await fetch(`${base}/api/auth/status`);
      if (response.ok) return { child, base };
    } catch { /* 临时服务尚未监听。 */ }
    await delay(25);
  }
  throw new Error(`测试服务启动超时：${logs}`);
}

const request = (base, headers = {}) => fetch(`${base}/v1/responses`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model: "gpt-5.6-sol", input: "测试", stream: false }),
});
const json = async (base, endpoint = "/api/status", headers = {}) => (await fetch(`${base}${endpoint}`, { headers })).json();

test("超过 5000 条与损坏半行的历史在请求和重启后保留，汇总不受日志页上限影响", async (t) => {
  const f = await fixture(t);
  const records = Array.from({ length: 5001 }, (_, index) => ({
    id: `old-${index}`, providerId: "history", providerName: "历史供应商", statusCode: 200,
    timestamp: "2026-01-01T00:00:00Z", totalTokens: 3, inputTokens: 2, outputTokens: 1,
  }));
  await writeFile(f.usagePath, `${records.map(JSON.stringify).join("\n")}\n坏行\n{"id":`);
  let service = await start(f);
  assert.equal((await json(service.base)).totalRequests, 5001);
  const response = await request(service.base, { "x-request-id": "persist-request-1" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "persist-request-1");
  await response.arrayBuffer();
  // 在响应已经送达后立即优雅退出，必须等待日志落盘。
  await stop(service.child);
  service = await start(f);
  const status = await json(service.base);
  assert.equal(status.totalRequests, 5002);
  assert.equal(status.persistence.usageRecordCount, 5002);
  assert.equal(status.persistence.malformedRecordCount, 2);
  assert.equal(status.lastRequestId, "persist-request-1");
  const summary = await json(service.base, "/api/billing/summary");
  assert.equal(summary.business.totalRequests, 5002);
  assert.equal(summary.business.totalTokens, 15006);
  assert.equal(summary.today.business.totalRequests, 1);
  assert.equal(summary.today.business.totalTokens, 3);
  assert.equal(summary.today.business.providers[0].name, "模拟供应商");
  const filtered = await json(service.base, "/api/billing/summary?providerId=history&endAt=2026-02-01");
  assert.equal(filtered.business.totalRequests, 5001);
  assert.equal(filtered.business.days[0].requests, 5001);
  const logs = await json(service.base, "/api/billing/logs?limit=5000");
  assert.equal(logs.records.length, 5000);
  assert.equal(logs.totalRecords, 5002);
  assert.equal(logs.truncated, true);
  assert.equal(logs.records[0].upstreamRequestId, "upstream-id");
  assert.ok((await readFile(f.usagePath, "utf8")).includes('"id":"old-0"'));
});

test("两个实例共用日志追加不会覆盖彼此记录", async (t) => {
  const f = await fixture(t);
  const first = await start(f);
  const second = await start(f);
  await Promise.all([request(first.base), request(second.base)].map(async (pending) => {
    const response = await pending;
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }));
  await stop(first.child);
  await stop(second.child);
  const restarted = await start(f);
  assert.equal((await json(restarted.base)).totalRequests, 2);
});

test("新实例能发现旧实例排空后追加的历史", async (t) => {
  const f = await fixture(t);
  const old = await start(f);
  const next = await start(f);
  const response = await request(old.base);
  await response.arrayBuffer();
  await stop(old.child);
  const status = await json(next.base);
  assert.equal(status.totalRequests, 1);
  assert.equal(status.persistence.usageRecordCount, 1);
  assert.equal((await json(next.base)).totalRequests, 1);
});

test("直接启动和重启脚本读取同一环境文件并保留公网地址和历史路径", async (t) => {
  const f = await fixture(t);
  const envFile = path.join(f.root, "runtime.env");
  await writeFile(envFile, [
    `LITE_CCSWITCH_CONFIG=${f.configPath}`,
    `LITE_CCSWITCH_USAGE=${f.usagePath}`,
    `LITE_CCSWITCH_PRICE_LAB=${path.join(f.root, "price-lab.json")}`,
    "LITE_CCSWITCH_HOST=0.0.0.0",
    "LITE_CCSWITCH_PROXY_TOKEN=test-proxy",
    "LITE_CCSWITCH_ADMIN_TOKEN=test-admin",
    `LITE_CCSWITCH_LOG=${path.join(f.root, "restart.log")}`,
  ].join("\n"));
  const service = await start(f, {
    LITE_CCSWITCH_ENV_FILE: envFile,
    LITE_CCSWITCH_HOST: undefined,
    LITE_CCSWITCH_CONFIG: undefined,
    LITE_CCSWITCH_USAGE: undefined,
  });
  const response = await request(service.base, { "x-lite-ccswitch-token": "test-proxy" });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const headers = { "x-lite-ccswitch-token": "test-admin" };
  const oldStatus = await json(service.base, "/api/status", headers);
  const restarted = spawn("bash", [path.join(ROOT, "restart.sh"), new URL(service.base).port], {
    cwd: ROOT,
    env: Object.fromEntries(Object.entries({ ...process.env,
      LITE_CCSWITCH_ENV_FILE: envFile, LITE_CCSWITCH_NODE: process.execPath,
    }).filter(([key]) => !key.startsWith("LITE_CCSWITCH_") || ["LITE_CCSWITCH_ENV_FILE", "LITE_CCSWITCH_NODE"].includes(key))),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  restarted.stdout.on("data", (data) => { output += data; });
  restarted.stderr.on("data", (data) => { output += data; });
  const [code] = await once(restarted, "exit");
  const nextStatus = await json(service.base, "/api/status", headers);
  const cleanup = () => {
    try { process.kill(nextStatus.processId, "SIGTERM"); } catch { /* 测试实例已退出。 */ }
  };
  t.after(cleanup);
  assert.equal(code, 0, output);
  assert.notEqual(nextStatus.instanceId, oldStatus.instanceId);
  assert.equal(nextStatus.address, "0.0.0.0");
  assert.equal(nextStatus.persistence.usagePath, f.usagePath);
  assert.equal(nextStatus.totalRequests, 1);
  cleanup();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(nextStatus.processId, 0); } catch { break; }
    await delay(20);
  }
});

test("公网未配置令牌时，代理与所有管理数据接口均拒绝访问", async (t) => {
  const f = await fixture(t);
  const { base } = await start(f, { LITE_CCSWITCH_HOST: "0.0.0.0" });
  for (const endpoint of ["/api/status", "/api/status/events", "/api/config", "/api/providers", "/api/providers/local", "/api/billing/logs", "/api/diagnostics/413"]) {
    assert.equal((await fetch(`${base}${endpoint}`)).status, 503, endpoint);
  }
  assert.equal((await request(base)).status, 503);
  assert.equal(f.requests.length, 0);
});

test("公网管理 Cookie 与状态流可用，代理令牌不会泄漏到上游", async (t) => {
  const f = await fixture(t);
  const { base } = await start(f, { LITE_CCSWITCH_HOST: "0.0.0.0", LITE_CCSWITCH_PROXY_TOKEN: "proxy-secret", LITE_CCSWITCH_ADMIN_TOKEN: "admin-secret" });
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/providers/local`, { headers: { "x-lite-ccswitch-token": "proxy-secret" } })).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "admin-secret" }) });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get("set-cookie");
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.ok(!cookieHeader.includes("admin-secret"));
  const cookie = cookieHeader.split(";")[0];
  assert.equal((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 200);
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/status/events`, { headers: { cookie }, signal: controller.signal });
  assert.equal(stream.status, 200);
  await stream.body.getReader().read();
  controller.abort();
  assert.equal((await request(base, { "x-lite-ccswitch-token": "admin-secret" })).status, 401);
  const response = await request(base, { "x-lite-ccswitch-token": "proxy-secret", cookie, "x-request-id": "observed-1" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "observed-1");
  await response.arrayBuffer();
  assert.equal(f.requests[0]["x-request-id"], "observed-1");
  assert.equal(f.requests[0]["x-lite-ccswitch-token"], undefined);
  assert.equal(f.requests[0].cookie, undefined);
});

test("用量写入失败显示错误，已成功请求不会被重试", async (t) => {
  const f = await fixture(t);
  const { base } = await start(f);
  await mkdir(f.usagePath);
  const response = await request(base);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await json(base);
    if (status.persistence.failedWrites) break;
    await delay(20);
  }
  assert.equal(status.persistence.failedWrites, 1);
  assert.ok(status.persistence.lastWriteError);
  assert.equal(f.requests.length, 1);
});
