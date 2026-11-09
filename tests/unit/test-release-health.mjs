/**
 * 本机健康检查与观察器测试：核对身份、端口、认证与时限，验证连续失败去抖和取消清理。
 * 仅使用本机 HTTP 服务与假的检查函数，不访问供应商或真实业务数据。
 */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { checkReleaseHealth, createReleaseHealthMonitor } from "../../lib/release-health.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i += 1) { if (check()) return; await pause(5); }
  throw new Error("等待健康观察测试状态超时");
}
const expected = { pid: 12345, port: 15725, build: { version: "test", releaseId: "test-candidate", codeHash: "test-hash" },
  configPath: "/isolated/config.json", usagePath: "/isolated/usage.jsonl" };
const healthy = () => ({ running: true, processId: expected.pid, port: expected.port, build: { ...expected.build },
  persistence: { configPath: expected.configPath, usagePath: expected.usagePath },
  groups: [{ id: "default", listener: { enabled: true, port: expected.port }, listenerStatus: "listening", actualListener: { port: expected.port } },
    { id: "quality", listener: { enabled: true, port: 15726 }, listenerStatus: "listening", actualListener: { port: 15726 } }] });
async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); assert.ok(server.address().port >= 15725);
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}/api/status`;
}

test("核对进程、版本、数据和启用分组；业务错误不会触发进程异常", async (t) => {
  let body = healthy(); const requests = [];
  const url = await fixture(t, (req, res) => { requests.push({ path: req.url, token: req.headers["x-lite-ccswitch-token"] }); res.end(JSON.stringify(body)); });
  const signal = new AbortController().signal;
  const check = () => checkReleaseHealth({ url, token: "fake-local-token", expected, signal });
  body.failedRequests = 100; body.lastError = "上游业务错误"; await check();
  const mutations = [
    (s) => { s.running = false; }, (s) => { s.processId += 1; }, (s) => { s.port += 1; },
    ...["version", "releaseId", "codeHash"].map((key) => (s) => { s.build[key] = "other"; }),
    (s) => { s.persistence.configPath = "/other"; }, (s) => { s.persistence.usagePath = "/other"; },
    (s) => { s.groups = []; }, (s) => { s.groups[0].listener.enabled = false; },
    (s) => { s.groups[1].listenerStatus = "not_listening"; }, (s) => { s.groups[1].actualListener.port += 1; },
  ];
  for (const mutate of mutations) { body = healthy(); mutate(body); await assert.rejects(check()); }
  body = healthy(); body.groups[1].listener.enabled = false; body.groups[1].actualListener = null; await check();
  assert.ok(requests.every((req) => req.path === "/api/status" && req.token === "fake-local-token"));
  assert.equal(getEventListeners(signal, "abort").length, 0, "重复检查后不能累积取消监听器");
});

test("HTTP 错误只记录状态码，错误正文不进入观察日志", async (t) => {
  const url = await fixture(t, (req, res) => { res.writeHead(401); res.end("secret-body-not-for-log"); });
  await assert.rejects(checkReleaseHealth({ url, expected, signal: new AbortController().signal }),
    (error) => error.message === "本机状态接口返回 HTTP 401");
});

for (const phase of ["headers", "body"]) test(`${phase} 阶段使用整次检查时限并释放连接`, async (t) => {
  let closed = false;
  const url = await fixture(t, (req, res) => {
    res.once("close", () => { closed = true; });
    if (phase === "body") { res.writeHead(200); res.write('{"running":'); }
  });
  const signal = new AbortController().signal;
  await assert.rejects(checkReleaseHealth({ url, expected, signal, timeoutMs: 40 }), /检查超时/);
  await until(() => closed); assert.equal(getEventListeners(signal, "abort").length, 0);
});

test("取消检查立即关闭读取，不再等待检查时限", async (t) => {
  let requested = false; let closed = false;
  const url = await fixture(t, (req, res) => { requested = true; res.once("close", () => { closed = true; }); });
  const controller = new AbortController();
  const pending = checkReleaseHealth({ url, expected, signal: controller.signal }); const rejected = assert.rejects(pending);
  await until(() => requested); const at = Date.now(); controller.abort(); await rejected; await until(() => closed);
  assert.ok(Date.now() - at < 300); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("连续失败才告警，单段异常不重复告警，检查串行且恢复后清零", async () => {
  const sequence = [false, false, true, false, false, false, false, true];
  const events = []; let index = 0; let active = 0; let maxActive = 0;
  const monitor = createReleaseHealthMonitor({ intervalMs: 1, onEvent: (e) => events.push(e), check: async () => {
    active += 1; maxActive = Math.max(maxActive, active); await pause(5); active -= 1;
    if (sequence[index++] === false) throw new Error("假的接口超时");
  } });
  try { await until(() => events.some((e) => e.event === "health_recovered")); } finally { await monitor.stop(); }
  assert.deepEqual(events.map((e) => e.event), ["health_monitor_started", "health_degraded", "health_recovered"]);
  assert.equal(events[1].consecutiveFailures, 3); assert.equal(events[1].action, "observe_only");
  assert.equal(events[2].failureCount, 4); assert.equal(maxActive, 1);
});

test("停止正在检查的观察器不误报，也不继续安排后续检查", async () => {
  const events = []; let calls = 0; let aborted = false;
  const monitor = createReleaseHealthMonitor({ intervalMs: 1, onEvent: (e) => events.push(e), check: (signal) => {
    calls += 1;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("取消")); }, { once: true }));
  } });
  await until(() => calls === 1); await monitor.stop(); await pause(15);
  assert.ok(aborted); assert.equal(calls, 1); assert.deepEqual(events.map((e) => e.event), ["health_monitor_started"]);
});

test("停止等待下次检查的观察器及时释放长定时器", async () => {
  let calls = 0; const at = Date.now();
  const monitor = createReleaseHealthMonitor({ onEvent: () => {}, check: () => { calls += 1; } });
  await monitor.stop(); assert.equal(calls, 0); assert.ok(Date.now() - at < 300);
});

test("告警记录失败不结束观察，后续仍能记录恢复", async () => {
  let calls = 0; const errors = []; const events = [];
  const monitor = createReleaseHealthMonitor({ intervalMs: 1,
    check: () => { if (++calls <= 3) throw new Error("接口超时"); },
    onError: (e) => errors.push(e.message), onEvent: (e) => { if (e.event === "health_degraded") throw new Error("模拟日志不可写"); events.push(e); },
  });
  try { await until(() => events.some((e) => e.event === "health_recovered")); } finally { await monitor.stop(); }
  assert.deepEqual(errors, ["模拟日志不可写"]); assert.ok(calls >= 4);
});
