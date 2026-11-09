/**
 * Lite CC Switch 两阶段关闭测试。
 *
 * 验证首次停止信号会排空已有连接，第二次信号或宽限期超时才强制销毁连接。
 */

import assert from "node:assert/strict";
import test from "node:test";

process.env.LITE_CCSWITCH_SKIP_BOOTSTRAP = "1";
const { createShutdownController } = await import("../../server.js");

function createHarness() {
  const timers = [];
  const exitCodes = [];
  const logs = [];
  let closeCallback = null;
  const response = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const socket = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const activeRequests = new Set([{}]);
  const server = {
    closeCalls: 0,
    closeIdleCalls: 0,
    closeAllCalls: 0,
    close(callback) {
      this.closeCalls += 1;
      closeCallback = callback;
    },
    closeIdleConnections() {
      this.closeIdleCalls += 1;
    },
    closeAllConnections() {
      this.closeAllCalls += 1;
    },
  };
  const schedule = (callback, delay) => {
    const timer = {
      callback,
      delay,
      cleared: false,
      unref() {},
    };
    timers.push(timer);
    return timer;
  };
  const shutdown = createShutdownController({
    server,
    activeRequests,
    activeStreamingResponses: new Set([response]),
    activeClientSockets: new Set([socket]),
    graceMs: 200,
    exit: (code) => exitCodes.push(code),
    setTimer: schedule,
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    log: (message) => logs.push(message),
  });

  return {
    activeRequests,
    closeServer: () => closeCallback?.(),
    exitCodes,
    logs,
    response,
    server,
    shutdown,
    socket,
    timers,
  };
}

test("首次停止信号会排空连接，第二次信号才强制断开", () => {
  const harness = createHarness();

  assert.equal(harness.shutdown.requestShutdown("SIGTERM"), "draining");
  assert.equal(harness.server.closeCalls, 1);
  assert.equal(harness.server.closeIdleCalls, 1);
  assert.equal(harness.response.destroyed, false);
  assert.equal(harness.socket.destroyed, false);
  assert.equal(harness.timers[0].delay, 200);
  assert.match(harness.logs[0], /再次发送 SIGTERM 或 SIGINT/);

  assert.equal(harness.shutdown.requestShutdown("SIGINT"), "forcing");
  assert.equal(harness.response.destroyed, true);
  assert.equal(harness.socket.destroyed, true);
  assert.equal(harness.server.closeAllCalls, 1);
  assert.equal(harness.timers[0].cleared, true);
  assert.match(harness.logs[1], /二次断开/);

  harness.closeServer();
  assert.deepEqual(harness.exitCodes, [0]);
});

test("超过宽限期会执行一次强制断开", () => {
  const harness = createHarness();

  harness.shutdown.requestShutdown("SIGTERM");
  harness.timers[0].callback();

  assert.equal(harness.shutdown.state(), "forcing");
  assert.equal(harness.response.destroyed, true);
  assert.equal(harness.socket.destroyed, true);
  assert.equal(harness.server.closeAllCalls, 1);
  assert.match(harness.logs[1], /宽限期已到/);

  harness.closeServer();
  assert.deepEqual(harness.exitCodes, [0]);
});

test("活动请求尚未完成时不会提前退出，完成后才结束进程", () => {
  const activeRequests = new Set([{}]);
  const harness = createHarness();
  const shutdown = createShutdownController({
    server: harness.server,
    activeRequests,
    activeStreamingResponses: new Set(),
    activeClientSockets: new Set(),
    graceMs: 0,
    exit: (code) => harness.exitCodes.push(code),
    log: (message) => harness.logs.push(message),
  });

  shutdown.requestShutdown("SIGTERM");
  harness.closeServer();
  assert.deepEqual(harness.exitCodes, []);

  activeRequests.clear();
  shutdown.requestFinished();
  assert.deepEqual(harness.exitCodes, [0]);
});

test("正常停止等待后台落盘，第二次信号仍可强制退出", async () => {
  for (const force of [false, true]) {
    const harness = createHarness(); let release; let flushCalls = 0;
    const shutdown = createShutdownController({
      server: harness.server, activeRequests: new Set(), activeStreamingResponses: new Set(), activeClientSockets: new Set(), graceMs: 0,
      beforeExit: () => { flushCalls += 1; return new Promise((resolve) => { release = resolve; }); },
      exit: (code) => harness.exitCodes.push(code), log: () => {},
    });
    shutdown.requestShutdown("SIGTERM"); harness.closeServer(); shutdown.requestFinished();
    assert.equal(flushCalls, 1); assert.deepEqual(harness.exitCodes, []);
    if (force) { shutdown.requestShutdown("SIGINT"); harness.closeServer(); assert.deepEqual(harness.exitCodes, [0]); }
    release(); await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.exitCodes, [0]);
  }
});
