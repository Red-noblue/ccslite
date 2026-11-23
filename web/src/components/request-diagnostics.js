/** 请求诊断中文说明；只解释已记录的证据，不根据当前配置推测历史。 */
const reasons = {
  manual_compatibility: "手动编码兼容性检查",
  preferred: "优先供应商", sticky: "会话粘滞", failover: "故障重试或转移",
  recovered_migration: "高优先级供应商恢复后回迁", previous_response: "响应上下文优先",
  previous_response_fallback: "响应上下文不兼容后回退",
};
const exclusions = {
  not_configured: "未配置上游地址", different_route: "不属于此入口",
  routing_disabled: "未参与本组自动路由", manual_not_selected: "单供应商模式未选中",
  circuit_open: "断路器暂时开启", model_unsupported: "模型暂不支持", not_selected: "未进入候选",
};
export const routeReasonText = (value) => reasons[value] || "当时未记录";
export const exclusionText = (value) => exclusions[value] || "当时未记录";
export function attemptStage(attempt) {
  if (attempt.outcome === "skipped") return "发起前跳过";
  if (attempt.outcome === "success") return attempt.streamDiagnostics ? "流式完整结束" : "响应成功";
  if (attempt.streamDiagnostics?.outputStarted) return "流已输出后失败，不能拼接另一供应商";
  if (attempt.streamDiagnostics) return "流式探测阶段失败，尚未输出";
  return attempt.statusCode ? "上游返回错误" : "连接或等待响应失败";
}
export function requestOutcome(log) {
  if (log.error || log.failureClass || log.statusCode >= 400) return "失败";
  const last = log.providerAttempts?.at(-1);
  if (last?.outcome === "failure") return "失败";
  if (last?.outcome === "success") return "已完成";
  return "完整性未记录";
}

export function requestExplanation(log) {
  const attempts = log.providerAttempts || [];
  const lines = [];
  if (log.routeSnapshot) {
    const first = log.routeSnapshot.candidates?.[0];
    const initialReason = ["failover", "previous_response_fallback"].includes(log.routeReason) ? log.routeSnapshot.contextProviderId ? "响应上下文优先" : log.routeSnapshot.stickyProviderId === first?.providerId ? "会话粘滞" : "优先顺序" : routeReasonText(log.routeReason);
    lines.push(first ? `开始时首先考虑 ${first.providerName}；选择依据：${initialReason}。` : "开始时没有可用候选。");
    if (log.routeSnapshot.contextProviderId) lines.push("请求携带旧响应上下文，优先保留其供应商；这可能与数字优先级顺序不同。");
  } else lines.push("旧日志未保存候选快照，无法判断当时为什么首先选择该供应商。");
  for (const [index, attempt] of attempts.entries()) {
    const prefix = `第 ${index + 1} 步：${attempt.providerName || "未知供应商"}`;
    if (attempt.outcome === "skipped") lines.push(`${prefix} 在发起前被跳过，没有发送此尝试。`);
    else if (attempt.outcome === "success") lines.push(`${prefix}${attempt.streamDiagnostics ? attempt.streamDiagnostics.events?.completed ? "收到完整流式结束事件" : "记录为成功，但未记录完整流式结束事件" : "响应成功"}。`);
    else if (attempt.streamDiagnostics?.outputStarted) lines.push(`${prefix} 在输出已开始后失败，无法把另一供应商的响应拼接进本次流。`);
    else lines.push(`${prefix}${attempt.streamDiagnostics ? "在有效输出前失败" : attempt.statusCode ? "返回错误" : "连接或等待响应失败"}${attempts.slice(index + 1).some((next) => next.outcome !== "skipped") ? "，随后继续下一次尝试" : "，没有记录到后续成功尝试"}。`);
  }
  if (!attempts.length) lines.push("当时未保存尝试链，HTTP 状态不能单独证明响应完整。");
  lines.push(requestOutcome(log) === "已完成" ? `本次由 ${log.providerName || "未知供应商"} 完成；这不代表后续请求一定继续选择它。` : `本次结果：${requestOutcome(log)}。`);
  return lines;
}
