/**
 * 中文交接 IPC 通道：每条连接共享监听器，按请求 ID 分发确认。
 * 超时表示结果未确认；调用方按业务幂等键或配置状态核对，不可盲目重发。
 */
import crypto from "node:crypto";

export function createHandoffRpc(peer, { timeoutMs = 35_000 } = {}) {
  const pending = new Map();
  const disconnected = () => {
    for (const id of [...pending.keys()]) finish(id, Object.assign(new Error("交接控制连接已经断开"), { code: "handoff_ipc_disconnected" }));
  };
  const onMessage = (message) => {
    const item = pending.get(message?.requestId);
    if (!item || ![item.replyType, item.failureType].includes(message.type)) return;
    const error = message.error || (message.type === item.failureType ? { message: message.message || "工作进程激活失败" } : null);
    finish(message.requestId, error ? Object.assign(new Error(error.message), { code: error.code, status: error.status || 500 }) : null,
      item.raw ? message : message.result);
  };
  function finish(id, error, value) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    if (!pending.size) {
      peer.off("message", onMessage); peer.off("disconnect", disconnected); peer.off("exit", disconnected);
    }
    if (error) item.reject(error); else item.resolve(value);
  }
  return {
    request(type, payload = {}, options = {}) {
      if (!peer.connected || typeof peer.send !== "function") return Promise.reject(Object.assign(new Error("交接控制连接已经断开"), { code: "handoff_ipc_disconnected" }));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        if (!pending.size) {
          peer.on("message", onMessage); peer.on("disconnect", disconnected); peer.on("exit", disconnected);
        }
        const timer = setTimeout(() => finish(id, Object.assign(new Error(`工作进程未确认 ${type}：等待确认超时`), {
          code: "handoff_ipc_timeout", status: 503,
        })), options.timeoutMs ?? timeoutMs);
        pending.set(id, { resolve, reject, timer, replyType: options.replyType || "handoff_control_result",
          failureType: options.failureType || "handoff_activation_failed", raw: options.raw === true });
        try { peer.send({ ...payload, type, requestId: id }, (error) => { if (error) finish(id, error); }); }
        catch (error) { finish(id, error); }
      });
    },
    state: () => ({ pending: pending.size }),
    close: disconnected,
  };
}
const connections = new WeakMap();
export function requestIpc(peer, type, payload = {}, options = {}) {
  let channel = connections.get(peer);
  if (!channel) { channel = createHandoffRpc(peer); connections.set(peer, channel); }
  return channel.request(type, payload, options);
}
export function requestHandoff(type, payload, options) { return requestIpc(process, type, payload, options); }
