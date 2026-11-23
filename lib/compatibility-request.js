/** 合成检查共用的 Responses 请求通道：限制响应大小与耗时，复用供应商认证、模型映射及用量记录。 */
import { buildProviderOnlyHeaders, joinUpstreamUrl, rectifyRequestBody } from "./upstream-request.js";
import { getProviderDispatcher } from "./upstream-proxy.js";
import { createSseInspector } from "./sse-stream.js";

const MAX_RESPONSE_BYTES = 512 * 1024;
export function createCompatibilityRequester({ provider, sessionContext, signal, onUsage = async () => {}, startActivity = () => () => {}, fetchImpl = fetch, timeoutMs = 30_000, remainingMs = () => timeoutMs, base }) {
  let requestCount = 0;
  const trace = [];
  async function request(step, patch) {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const requestTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs()));
    const timer = setTimeout(abort, requestTimeoutMs);
    let status = 0;
    let body = Buffer.alloc(0);
    let payload = null;
    let error = "";
    let errorKind = "";
    let upstreamInterrupted = false;
    let reading = false;
    let isSse = false;
    let protocol = "unknown";
    let firstByteMs = null;
    let finishActivity = () => {};
    requestCount += 1;
    try {
      const headers = await buildProviderOnlyHeaders(provider, sessionContext);
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      finishActivity = startActivity();
      const requestBody = rectifyRequestBody(provider, Buffer.from(JSON.stringify({ ...base, ...patch })));
      const effectiveModel = JSON.parse(requestBody.toString()).model;
      const response = await fetchImpl(joinUpstreamUrl(provider.baseUrl, "/v1/responses", "", provider), {
        method: "POST", headers, body: requestBody,
        signal: controller.signal, dispatcher: getProviderDispatcher(provider),
      });
      status = response.status;
      const contentType = response.headers.get("content-type") || "";
      isSse = /text\/event-stream/i.test(contentType);
      protocol = isSse ? "sse" : /json/i.test(contentType) ? "json" : "other";
      const reader = response.body?.getReader();
      if (!reader) throw new Error("上游未返回响应体");
      const chunks = [];
      let size = 0;
      try {
        reading = true;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstByteMs === null && value.byteLength) firstByteMs = Date.now() - startedAt;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error("检查响应超过 512 KiB，已停止");
          chunks.push(Buffer.from(value));
        }
        reading = false;
      } finally {
        body = Buffer.concat(chunks);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!response.ok) throw new Error(`上游返回 HTTP ${status}，请核对认证、模型及接口能力`);
      if (isSse) {
        const inspector = createSseInspector();
        const inspection = inspector.feed(body);
        // Responses 检查要求完整 completed 对象，不能仅凭 HTTP 200 或 [DONE] 判定成功。
        for (const block of body.toString("utf8").split(/\r?\n\r?\n/)) {
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            if (event.type === "response.completed") payload = event.response;
            if (event.type === "response.incomplete") upstreamInterrupted = true;
          } catch {}
        }
        if (upstreamInterrupted) throw new Error("响应未完整完成（可能达到输出限制或被上游中止）");
        if (inspection.error) {
          upstreamInterrupted = [401, 402, 403, 408, 429].includes(inspection.error.status) || inspection.error.status >= 500;
          throw new Error("上游流中返回错误事件");
        }
        if (!payload || !inspector.summary().completed) throw new Error("未收到完整的 response.completed 事件");
      } else {
        try { payload = JSON.parse(body.toString("utf8")); protocol = "json"; } catch { throw new Error("上游响应不是合法 JSON 或 SSE"); }
      }
      if (controller.signal.aborted) throw new Error("检查已取消");
      if (!Array.isArray(payload?.output)) throw new Error("上游缺少 Responses output 数组");
      if (payload?.status !== "completed") throw new Error("响应未完整完成（可能达到输出限制或被上游中止）");
      if (payload.model && payload.model !== effectiveModel) throw new Error("上游返回的模型与检查模型不一致");
    } catch (caught) {
      errorKind = signal?.aborted ? "cancelled" : controller.signal.aborted || upstreamInterrupted || reading || !status || [401, 402, 403, 408, 429].includes(status) || status >= 500 || payload?.status === "incomplete" ? "inconclusive" : "failed";
      // 不回显上游原文、URL 或请求头，防止检查结果包含供应商认证信息。
      error = controller.signal.aborted ? (signal?.aborted ? "检查已取消" : `单次检查超过 ${Math.round(requestTimeoutMs / 1000)} 秒`)
        : caught.message?.startsWith("上游") || caught.message?.startsWith("未收到") || caught.message?.startsWith("响应未") || caught.message?.startsWith("检查响应") ? caught.message : "连接或读取失败";
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      finishActivity();
    }
    const traceItem = { sequence: requestCount, step: String(step).slice(0, 80), protocol, statusCode: status, firstByteMs,
      responseBytes: body.length, latencyMs: Date.now() - startedAt, outcome: error ? errorKind || "failed" : "completed" };
    trace.push(traceItem);
    await onUsage({ step, statusCode: status, responseBody: body, responseText: isSse ? body.toString("utf8") : "", isStreaming: isSse, latencyMs: traceItem.latencyMs, error });
    return { payload, error, errorKind, isSse, status, latencyMs: traceItem.latencyMs };
  }

  return { request, trace, get requestCount() { return requestCount; } };
}
