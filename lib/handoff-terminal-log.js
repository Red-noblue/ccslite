/**
 * 中文前置器终端日志过滤：隐藏高频持久化明细，保留日志文件中的完整审计记录。
 */

// 这些事件仍会写入 handoff-events.jsonl，但默认不直接打印到启动终端。
export const QUIET_HANDOFF_EVENTS = new Set([
  "handoff_request_finished",
  "handoff_usage_committed",
  "handoff_config_committed",
  "handoff_sessions_drained",
]);

export function shouldPrintHandoffLog(line, { verbose = false } = {}) {
  if (verbose) return true;
  try {
    const value = JSON.parse(String(line));
    return !QUIET_HANDOFF_EVENTS.has(value?.event);
  } catch {
    // 普通中文错误消息或非 JSON 行属于低频诊断信息，继续打印。
    return true;
  }
}
