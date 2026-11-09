/**
 * 自动连通性测试调度器测试。
 *
 * 验证修改间隔才重新起算、永不不会安排计时，手动检测和检测耗时不推迟统一周期。
 */

import assert from "node:assert/strict";
import test from "node:test";

process.env.LITE_CCSWITCH_SKIP_BOOTSTRAP = "1";
const { createConnectivityScheduler, normalizeConnectivityInterval } = await import("../../server.js");

function createTimerHarness() {
  let nowMs = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => nowMs,
    setNow(value) {
      nowMs = value;
    },
    setTimer(callback, delay) {
      const timer = { id: ++nextId, callback, delay, cleared: false };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
      timers.delete(timer.id);
    },
    latest() {
      return [...timers.values()].at(-1) || null;
    },
  };
}

test("连通性间隔限制为 0.5 小时至一个月，永不返回 null", () => {
  assert.equal(normalizeConnectivityInterval(1), 30 * 60_000);
  assert.equal(normalizeConnectivityInterval(31 * 24 * 60 * 60_000), 30 * 24 * 60 * 60_000);
  assert.equal(normalizeConnectivityInterval("never", 123), null);
  assert.equal(normalizeConnectivityInterval(null, 123), null);
});

test("修改间隔会清除旧计时并从修改时刻重新安排", () => {
  const harness = createTimerHarness();
  let intervalMs = 3 * 60 * 60_000;
  const scheduler = createConnectivityScheduler({
    getIntervalMs: () => intervalMs,
    runTests: async () => ({ ok: true }),
    now: harness.now,
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
  });

  scheduler.start();
  const firstTimer = harness.latest();
  assert.equal(firstTimer.delay, 3 * 60 * 60_000);
  harness.setNow(1_000);
  intervalMs = 2 * 60 * 60_000;
  scheduler.reschedule();

  assert.equal(firstTimer.cleared, true);
  assert.equal(harness.latest().delay, 2 * 60 * 60_000);
  assert.equal(scheduler.status().nextRunAt, new Date(1_000 + 2 * 60 * 60_000).toISOString());
});

test("永不不安排计时，手动测试完成后按当前间隔安排下一轮", async () => {
  const harness = createTimerHarness();
  let intervalMs = null;
  let runCount = 0;
  const scheduler = createConnectivityScheduler({
    getIntervalMs: () => intervalMs,
    runTests: async () => {
      runCount += 1;
      return { ok: true };
    },
    now: harness.now,
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
  });

  scheduler.start();
  assert.equal(harness.latest(), null);
  intervalMs = 30 * 60_000;
  const run = scheduler.runNow();
  await run;
  assert.equal(runCount, 1);
  assert.equal(harness.latest().delay, 30 * 60_000);
  assert.equal(scheduler.status().lastRunReason, "manual");
});

test("全局周期从首次启动起算，重复启动和手动检测不推迟下一轮", async () => {
  const harness = createTimerHarness();
  const day = 24 * 60 * 60_000;
  const calls = [];
  const scheduler = createConnectivityScheduler({
    getIntervalMs: () => day,
    runTests: async (reason, groupId) => { calls.push({ reason, groupId }); },
    now: harness.now, setTimer: harness.setTimer, clearTimer: harness.clearTimer,
  });
  scheduler.start();
  harness.setNow(2 * 60 * 60_000);
  scheduler.start();
  assert.equal(scheduler.status().nextRunAt, new Date(day).toISOString());
  await scheduler.runNow("later-group");
  assert.equal(scheduler.status().nextRunAt, new Date(day).toISOString());
  harness.setNow(day + 1_000);
  harness.latest().callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ reason: "manual", groupId: "later-group" }, { reason: "periodic", groupId: undefined }]);
  assert.equal(scheduler.status().nextRunAt, new Date(2 * day).toISOString());
});
