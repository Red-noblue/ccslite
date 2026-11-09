/**
 * 分组端口监听器：按配置即时启停，换端口时保留旧连接，并统一参与优雅关闭。
 */
import http from "node:http";

export function createGroupListeners({ mainServer, mainPort, resolvePort = (group) => group.listener.port,
  resolveHost = (group) => group.listener.host, allowEphemeralPort = false, handleRequest, onConnection, onChange = () => {} }) {
  const entries = new Map();
  const servers = new Set([mainServer]);
  let queue = Promise.resolve();
  let stopping = false;

  function status(groupId) {
    const entry = entries.get(groupId);
    const server = groupId === "default" ? mainServer : entry?.server;
    const address = server?.listening ? server.address() : null;
    return {
      actualListener: address ? { host: address.address, port: address.port } : null,
      listenerStatus: address ? "listening" : entry?.error ? "error" : "not_listening",
      listenerError: entry?.error || "",
    };
  }

  function retire(server) {
    if (!server) return;
    server.close(() => servers.delete(server));
    server.closeIdleConnections?.();
  }

  async function configure(group) {
    if (stopping) throw Object.assign(new Error("服务正在关闭"), { status: 503 });
    if (group.id === "default") return;
    const previous = entries.get(group.id);
    if (!group.listener?.enabled) {
      entries.delete(group.id);
      retire(previous?.server);
      onChange();
      return;
    }
    const host = resolveHost(group);
    const port = Number(resolvePort(group));
    if (!Number.isInteger(port) || port < (allowEphemeralPort ? 0 : 1) || port > 65535) {
      throw Object.assign(new Error("分组端口必须为 1～65535 的整数"), { status: 400 });
    }
    if (previous?.server?.listening && previous.host === host && (previous.port === port || (allowEphemeralPort && port === 0))) return;
    // 独立端口不与主端口或其他分组复用，避免同端口不同地址造成配置歧义。
    if (port === mainPort || [...entries].some(([id, entry]) => id !== group.id && entry.server?.listening && entry.port === port)) {
      throw Object.assign(new Error(`端口 ${port} 已被主服务或其他分组使用`), { status: 409, code: "EADDRINUSE" });
    }
    const server = http.createServer((req, res) => handleRequest(req, res, group.id, host));
    if (onConnection) server.on("connection", onConnection);
    server.requestTimeout = 0;
    server.headersTimeout = 65_000;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolve(); });
      });
    } catch (cause) {
      const error = Object.assign(new Error(`分组端口 ${host}:${port} 监听失败（${cause.code || cause.message}）`), { status: 409, code: cause.code });
      if (!previous?.server?.listening) entries.set(group.id, { error: error.message });
      throw error;
    }
    if (stopping) {
      retire(server);
      throw Object.assign(new Error("服务正在关闭"), { status: 503 });
    }
    servers.add(server);
    entries.set(group.id, { server, host, port: server.address().port, error: "" });
    retire(previous?.server);
    onChange();
  }

  return {
    status,
    apply(group) {
      const task = queue.catch(() => {}).then(() => configure(group));
      queue = task;
      return task;
    },
    close(callback) {
      stopping = true;
      const listening = [...servers].filter((server) => server.listening);
      if (!listening.length) { callback?.(); return; }
      let remaining = listening.length;
      for (const server of listening) server.close(() => { if (--remaining === 0) callback?.(); });
    },
    closeIdleConnections() { for (const server of servers) server.closeIdleConnections?.(); },
    closeAllConnections() { for (const server of servers) server.closeAllConnections?.(); },
  };
}
