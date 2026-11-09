/**
 * 中文升级交接队列：旧版本排空时暂存新请求，候选版本取得写入权后统一放行。
 * 队列只保存已读入内存的请求体，受数量和字节数限制；默认等待到交接完成，客户端取消会立即移除。
 */

function queueError(message, status, code, retryAfter = null) {
  const error = Object.assign(new Error(message), { status, code });
  if (retryAfter !== null) error.retryAfter = retryAfter;
  return error;
}

export function createHandoffQueue({ maxRequests = 32, maxBytes = 16 * 1024 * 1024, maxWaitMs = 0, onEvent = () => {} } = {}) {
  let state = "open";
  let target = null;
  let queuedBytes = 0;
  let inFlight = 0;
  let closedError = null;
  const items = new Set();

  const emit = (event, details = {}) => {
    try { onEvent({ event, queuedRequests: items.size, queuedBytes, inFlight, ...details }); }
    catch { /* 交接日志故障不能让请求队列失去清理能力。 */ }
  };

  const settle = (item, method, value) => {
    if (!items.delete(item)) return;
    clearTimeout(item.timer);
    item.signal?.removeEventListener("abort", item.abort);
    queuedBytes -= item.bytes;
    item[method](value);
  };

  const dispatch = async (item) => {
    if (!target || !items.has(item) || item.dispatched) return;
    item.dispatched = true;
    inFlight += 1;
    try { settle(item, "resolve", await target(item.request)); }
    catch (error) { settle(item, "reject", error); }
    finally { inFlight -= 1; emit("handoff_request_finished"); }
  };

  const flush = () => {
    if (!target || state !== "open") return;
    for (const item of [...items]) void dispatch(item);
    emit("handoff_queue_released");
  };

  return {
    state: () => state,
    failure: () => closedError,
    stats: () => ({ state, queuedRequests: items.size, queuedBytes, inFlight }),
    beginDrain() {
      if (state === "closed") throw queueError("交接队列已经关闭", 503, "handoff_closed");
      state = "draining"; target = null; emit("handoff_draining");
    },
    activate(nextTarget) {
      if (typeof nextTarget !== "function") throw new TypeError("交接目标必须是函数");
      if (state === "closed") throw queueError("交接队列已经关闭", 503, "handoff_closed");
      target = nextTarget; state = "open"; emit("handoff_activated"); flush();
    },
    route(request, directTarget = target) {
      if (state === "open" && directTarget) {
        // 先计数再异步转发，避免工作进程尚未收到请求时被误判为已经排空。
        inFlight += 1;
        return Promise.resolve().then(() => directTarget(request)).finally(() => { inFlight -= 1; emit("handoff_request_finished"); });
      }
      if (state === "closed") return Promise.reject(closedError);
      const body = request?.body;
      const bytes = Buffer.isBuffer(body) ? body.length : body == null ? 0 : Buffer.byteLength(String(body));
      if (items.size >= maxRequests) return Promise.reject(queueError("升级交接队列已满", 503, "handoff_queue_full", 1));
      if (queuedBytes + bytes > maxBytes) return Promise.reject(queueError("请求体超过升级交接队列上限", 413, "handoff_body_too_large"));
      return new Promise((resolve, reject) => {
        const item = { request, bytes, resolve, reject, timer: null, signal: request?.signal };
        item.abort = () => settle(item, "reject", queueError("客户端已取消排队请求", 499, "client_cancelled"));
        if (item.signal?.aborted) { reject(queueError("客户端已取消排队请求", 499, "client_cancelled")); return; }
        item.signal?.addEventListener("abort", item.abort, { once: true });
        if (maxWaitMs > 0) item.timer = setTimeout(() => settle(item, "reject", queueError("升级交接等待超时", 503, "handoff_queue_timeout", 1)), maxWaitMs);
        items.add(item); queuedBytes += bytes; emit("handoff_request_queued");
      });
    },
    close(error = queueError("升级交接队列已关闭", 503, "handoff_closed", 1)) {
      state = "closed"; target = null;
      closedError = error;
      for (const item of [...items]) settle(item, "reject", error);
      emit("handoff_closed");
    },
  };
}
