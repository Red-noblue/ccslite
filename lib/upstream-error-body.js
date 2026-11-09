/**
 * 有界读取上游 HTTP 错误正文，保留原状态码所需的诊断前缀。
 * 整段读取受既有超时和 64 KiB 上限约束，超时、截断或取消时主动关闭上游。
 */
export async function readUpstreamErrorBody(response, controller, timeoutMs) {
  if (!response.body) return `HTTP ${response.status}`;
  const reader = response.body.getReader();
  const chunks = [];
  const maxBytes = 64 * 1024;
  let bytes = 0;
  let completed = false;
  let stoppedReason = "";
  const timer = setTimeout(() => {
    stoppedReason = "错误正文读取超时，已停止读取";
    controller.abort();
  }, timeoutMs);
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      const chunk = Buffer.from(value.subarray(0, maxBytes - bytes));
      chunks.push(chunk);
      bytes += chunk.length;
    }
    if (!completed) stoppedReason = "错误正文达到 64 KiB 上限，已停止读取";
  } catch (error) {
    // 客户端或管理台取消应由请求层分类，不能转换为一次新的上游失败与重试。
    if (controller.signal.aborted && !stoppedReason) throw error;
    stoppedReason ||= "错误正文读取失败";
  } finally {
    clearTimeout(timer);
    if (!completed) {
      controller.abort();
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8").slice(0, 4000) || `HTTP ${response.status}`;
  // 将停止原因放在前面，避免用量日志进一步截断错误摘要时丢失关键诊断。
  return stoppedReason ? `[${stoppedReason}]\n${text}` : text;
}
