/**
 * 中文版本交接状态机：候选版本先预热，旧版本排空后再转移唯一写入权。
 * 它不绑定 HTTP 实现；端口监听、进程回收和请求转发由上层监督器提供。
 */
import { setTimeout as delay } from "node:timers/promises";

// 旧版本活动请求的默认排空等待上限。长 Responses/SSE 请求可以自然完成，
// 超过此时间只取消本次升级，不强制断开旧版本连接。
export const DEFAULT_HANDOFF_DRAIN_TIMEOUT_MS = 300_000;

function handoffError(message, code = "handoff_failed", status = 503) {
  return Object.assign(new Error(message), { code, status });
}

export function createHandoffCoordinator({ queue, startCandidate, checkCandidate, stopCandidate,
  preparePrevious = async () => {}, prepareContinuation = async () => {}, onActivated = async () => {}, onSessionActivated = async () => {}, onPreviousRetired = async () => {}, canRetirePrevious = async () => true, acquireWriteLease, releaseWriteLease, dispatch, getActiveRequests, idlePollMs = 25, idleTimeoutMs = DEFAULT_HANDOFF_DRAIN_TIMEOUT_MS,
  onEvent = () => {} }) {
  let phase = "active";
  let current = null;
  let previous = null;

  const emit = (event, details = {}) => {
    try { onEvent({ event, phase, ...details }); } catch { /* 交接日志失败不能跳过恢复路径。 */ }
  };
  const waitForIdle = async () => {
    const deadline = Date.now() + idleTimeoutMs;
    while (await getActiveRequests() > 0) {
      if (Date.now() >= deadline) throw handoffError("旧版本活动请求未在交接期限内排空", "handoff_drain_timeout");
      await delay(idlePollMs);
    }
  };
  return {
    state: () => ({ phase, current: current?.id || null, previous: previous?.id || null }),
    setCurrent(worker) {
      if (phase !== "active" || current) throw handoffError("当前版本已经设置，不能重复初始化", "handoff_invalid_state", 409);
      current = worker; emit("handoff_current_set", { worker: worker.id });
    },
    async upgrade(candidate) {
      if (phase !== "active" || !current || previous) throw handoffError("当前不在可升级状态，或上一版本仍在观察保留期", "handoff_invalid_state", 409);
      phase = "preparing"; emit("handoff_preparing", { candidate: candidate.id });
      const old = current;
      let started = null;
      let previousPrepared = false;
      try {
        started = await startCandidate(candidate, { readOnly: true });
        await checkCandidate(started, { readOnly: true });
        if (phase === "closed") throw handoffError("交接已经停止", "handoff_closed");
        phase = "draining"; emit("handoff_draining", { oldWorker: current.id, candidate: started.id });
        queue.beginDrain();
        await waitForIdle();
        if (phase === "closed") throw handoffError("交接已经停止", "handoff_closed");
        previousPrepared = true;
        await preparePrevious(current);
        await releaseWriteLease(current);
        await acquireWriteLease(started);
        await onActivated(started);
        previous = old; current = started;
        queue.activate((request) => dispatch(current, request));
        phase = "active"; emit("handoff_activated", { worker: current.id, retiredWorker: previous.id });
        return current;
      } catch (error) {
        if (started) { try { await stopCandidate(started); } catch (cleanup) { emit("handoff_cleanup_error", { message: cleanup.message }); } }
        if (phase === "draining" || phase === "preparing") {
          if (previousPrepared) {
            try {
              await acquireWriteLease(old);
              await onActivated(old);
            } catch (restoreError) {
              phase = "failed"; queue.close(restoreError);
              emit("handoff_restore_error", { message: restoreError.message });
              throw new AggregateError([error, restoreError], "候选激活失败且旧版本恢复失败");
            }
          }
          current = old;
          if (queue.state() !== "closed") queue.activate((request) => dispatch(current, request));
          phase = "active"; emit("handoff_failed", { candidate: candidate.id, message: error.message, restored: true });
        }
        throw error;
      }
    },
    async upgradeSession(candidate) {
      if (phase !== "active" || !current || previous) throw handoffError("当前不在可会话交接状态，或上一版本仍在观察保留期", "handoff_invalid_state", 409);
      phase = "preparing"; emit("handoff_session_preparing", { candidate: candidate.id });
      const old = current;
      let started = null;
      try {
        started = await startCandidate(candidate, { readOnly: true });
        await checkCandidate(started, { readOnly: true });
        phase = "session_switching"; emit("handoff_session_switching", { oldWorker: old.id, candidate: started.id });
        await prepareContinuation(old);
        await releaseWriteLease(old);
        await acquireWriteLease(started);
        await onSessionActivated(started, old);
        previous = old; current = started;
        phase = "active_parallel";
        emit("handoff_session_activated", { worker: current.id, legacyWorker: previous.id });
        return current;
      } catch (error) {
        if (started) { try { await stopCandidate(started); } catch (cleanup) { emit("handoff_cleanup_error", { message: cleanup.message }); } }
        try {
          await acquireWriteLease(old);
          await onActivated(old);
        } catch (restoreError) {
          phase = "failed"; queue.close(restoreError);
          emit("handoff_restore_error", { message: restoreError.message });
          throw new AggregateError([error, restoreError], "会话交接失败且旧版本恢复失败");
        }
        current = old; phase = "active";
        emit("handoff_session_failed", { candidate: candidate.id, message: error.message, restored: true });
        throw error;
      }
    },
    async recover(candidate, reason = "worker_exited", { prepareCurrent = false } = {}) {
      if (!["active", "active_parallel"].includes(phase) || !current) throw handoffError("当前不在可启动固定回退包的状态", "handoff_invalid_state", 409);
      const retiring = [...new Set([current, previous].filter(Boolean))];
      phase = "recovering"; queue.beginDrain(); emit("handoff_recovery_started", { from: current.id, to: candidate.id, reason });
      let started = null;
      try {
        started = await startCandidate(candidate, { readOnly: true });
        await checkCandidate(started, { readOnly: true });
        if (phase === "closed") throw handoffError("交接已经停止", "handoff_closed");
        if (prepareCurrent) await prepareContinuation(current);
        await releaseWriteLease(current);
        await acquireWriteLease(started); await onActivated(started);
        current = started; previous = null;
        queue.activate((request) => dispatch(current, request));
        phase = "active"; emit("handoff_recovery_completed", { worker: current.id, reason });
        // 固定备份接管后才让旧进程停止收新请求；其已有流继续排空，用量仍可提交。
        for (const worker of retiring) {
          void Promise.resolve().then(() => stopCandidate(worker)).then(async () => {
            await onPreviousRetired(worker);
            emit("handoff_previous_retired", { worker: worker.id });
          }).catch((error) => emit("handoff_cleanup_error", { worker: worker.id, message: error.message }));
        }
        return current;
      } catch (error) {
        if (started) { try { await stopCandidate(started); } catch (cleanup) { emit("handoff_cleanup_error", { message: cleanup.message }); } }
        if (phase !== "closed") { phase = "failed"; queue.close(error); }
        emit("handoff_recovery_failed", { message: error.message, reason }); throw error;
      }
    },
    async retirePrevious() {
      if ((phase !== "active" && phase !== "active_parallel") || !previous) return false;
      if (!(await canRetirePrevious(previous))) return false;
      const retired = previous; previous = null; await stopCandidate(retired); await onPreviousRetired(retired);
      // 旧版本完全退役后，当前版本已经不再处于并行交接观察期，必须恢复可再次升级状态。
      phase = "active";
      emit("handoff_previous_retired", { worker: retired.id }); return true;
    },
    fail(error) {
      if (phase === "closed") return;
      phase = "failed"; queue.close(error); emit("handoff_failed_state", { message: error.message });
    },
    close(error) { phase = "closed"; queue.close(error); emit("handoff_closed"); },
  };
}
