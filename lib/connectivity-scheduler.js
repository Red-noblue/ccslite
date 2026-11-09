/**
 * 自动连通性测试调度模块。
 * 整个服务共用一个固定周期；分组启停和手动检测不改变周期，修改间隔才重新起算。
 */

import {
  formatConnectivityInterval,
  normalizeConnectivityInterval,
} from "./model-support.js";

export function createConnectivityScheduler({
  getIntervalMs,
  runTests,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
}) {
  let timer = null;
  let runPromise = null;
  let nextRunAt = null;
  let lastRunAt = null;
  let lastRunReason = null;
  let cycleStartedAt = null;
  let stopped = false;

  function clearScheduledRun() {
    if (timer) clearTimer(timer);
    timer = null;
    nextRunAt = null;
  }

  function scheduleNext() {
    clearScheduledRun();
    if (stopped || runPromise) return;
    const intervalMs = normalizeConnectivityInterval(getIntervalMs(), null);
    if (intervalMs === null) {
      log("自动连通性测试已停用");
      return;
    }
    if (cycleStartedAt === null) cycleStartedAt = now();
    const currentTime = now();
    const elapsedCycles = Math.floor((currentTime - cycleStartedAt) / intervalMs);
    nextRunAt = cycleStartedAt + (elapsedCycles + 1) * intervalMs;
    timer = setTimer(() => {
      timer = null;
      nextRunAt = null;
      trigger("periodic").catch((error) => {
        log(`定期连通性测试异常：${error?.message || error}`);
      });
    }, nextRunAt - currentTime);
    timer?.unref?.();
    log(`定期连通性测试已启动，间隔 ${formatConnectivityInterval(intervalMs)}`);
  }

  function finishRun() {
    lastRunAt = new Date(now()).toISOString();
    runPromise = null;
    scheduleNext();
  }

  function trigger(reason, groupId) {
    if (runPromise) return runPromise;
    clearScheduledRun();
    runPromise = Promise.resolve().then(() => runTests(reason, groupId));
    runPromise.then(
      () => {
        lastRunReason = reason;
        finishRun();
      },
      () => {
        lastRunReason = reason;
        finishRun();
      },
    );
    return runPromise;
  }

  return {
    start: () => { stopped = false; scheduleNext(); },
    stop: () => { stopped = true; clearScheduledRun(); },
    reschedule: () => { cycleStartedAt = now(); scheduleNext(); },
    runNow: (groupId) => trigger("manual", groupId),
    isRunning: () => Boolean(runPromise),
    status: () => ({
      periodicIntervalMs: normalizeConnectivityInterval(getIntervalMs(), null),
      nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
      lastRunAt,
      lastRunReason,
      running: Boolean(runPromise),
    }),
  };
}
