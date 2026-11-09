/**
 * 版本监督器的只读健康观察：核对本机服务身份，连续失败时记录异常，恢复时记录恢复。
 * 不调用供应商、不发送进程信号；停止观察会取消正在等待的检查和定时器。
 */
import { setTimeout as delay } from "node:timers/promises";

export const RELEASE_HEALTH_POLICY = Object.freeze({ intervalMs: 5000, timeoutMs: 1000, failureThreshold: 3 });

export async function checkReleaseHealth({ url, token, expected, signal, timeoutMs = RELEASE_HEALTH_POLICY.timeoutMs }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.throwIfAborted(); signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false; let consumed = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal,
      headers: token ? { "x-lite-ccswitch-token": token } : {} });
    if (!response.ok) throw new Error(`本机状态接口返回 HTTP ${response.status}`);
    const status = await response.json(); consumed = true;
    if (status?.running !== true) throw new Error("本机状态接口未报告服务正在运行");
    if (status.processId !== expected.pid) throw new Error("本机端口响应来自其他进程");
    if (status.port !== expected.port) throw new Error("本机服务端口与监督器登记不一致");
    if (["version", "releaseId", "codeHash"].some((key) => status.build?.[key] !== expected.build[key]))
      throw new Error("本机服务版本与监督器登记不一致");
    if (status.persistence?.configPath !== expected.configPath || status.persistence?.usagePath !== expected.usagePath)
      throw new Error("本机服务数据路径与监督器登记不一致");
    const groups = status.groups;
    if (!Array.isArray(groups) || !groups.some((g) => g.id === "default" && g.listener?.enabled && g.listener.port === expected.port))
      throw new Error("本机状态缺少正在监听的默认分组");
    if (groups.some((g) => g.listener?.enabled && (g.listenerStatus !== "listening" || g.actualListener?.port !== g.listener.port)))
      throw new Error("启用分组的实际监听端口与配置不一致");
    return status;
  } catch (error) {
    if (timedOut && !signal.aborted) throw new Error("本机状态接口检查超时");
    throw error;
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", onAbort);
    if (!consumed) controller.abort();
  }
}

export function createReleaseHealthMonitor({ check, onEvent, intervalMs = RELEASE_HEALTH_POLICY.intervalMs,
  failureThreshold = RELEASE_HEALTH_POLICY.failureThreshold,
  onError = (error) => console.error(`健康观察记录失败：${error.message}`) }) {
  const controller = new AbortController(); const { signal } = controller;
  let failures = 0; let degraded = false; let firstFailureAt = null;
  const emit = async (event, details) => {
    try { await onEvent({ event, ...details }); } catch (error) { onError(error); }
  };
  const done = (async () => {
    await emit("health_monitor_started", { ...RELEASE_HEALTH_POLICY, intervalMs, failureThreshold,
      message: "已启动本机服务健康观察，异常仅提示，不中断连接。" });
    while (!signal.aborted) {
      try { await delay(intervalMs, undefined, { signal }); } catch (error) { if (signal.aborted) return; throw error; }
      let failure;
      try { await check(signal); } catch (error) { failure = error; }
      if (signal.aborted) return;
      if (failure) {
        firstFailureAt ??= Date.now(); failures += 1;
        if (!degraded && failures >= failureThreshold) {
          degraded = true;
          await emit("health_degraded", { consecutiveFailures: failures, firstFailureAt: new Date(firstFailureAt).toISOString(),
            lastError: failure.message, action: "observe_only", message: "版本服务连续未通过本机健康检查，请检查日志；当前进程与连接已保留。" });
        }
      } else {
        if (degraded) await emit("health_recovered", { failureCount: failures, durationMs: Date.now() - firstFailureAt,
          message: "版本服务的本机健康检查已恢复。" });
        failures = 0; degraded = false; firstFailureAt = null;
      }
    }
  })().catch(onError);
  return { stop() { controller.abort(); return done; } };
}
