/**
 * lite-ccswitch 两阶段优雅关闭控制器。
 * 首次停止信号排空活动请求，第二次信号或宽限期超时才强制断开。
 */

const FORCED_SHUTDOWN_EXIT_MS = 5_000;

export function createShutdownController({
  server,
  activeRequests = new Set(),
  activeStreamingResponses,
  activeClientSockets,
  graceMs,
  onDraining = () => {},
  beforeExit,
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = (message) => console.log(message),
}) {
  let shutdownState = "running";
  let graceTimer = null;
  let forcedExitTimer = null;
  let exitRequested = false;
  let backgroundStarted = false;
  let backgroundFinished = false;

  const startTimer = (callback, delay) => {
    const timer = setTimer(callback, delay);
    timer?.unref?.();
    return timer;
  };

  const clearActiveTimer = (timer) => {
    if (timer) clearTimer(timer);
  };

  const requestExit = (code) => {
    if (exitRequested) return;
    exitRequested = true;
    clearActiveTimer(graceTimer);
    clearActiveTimer(forcedExitTimer);
    exit(code);
  };

  const finishShutdown = () => {
    if (shutdownState === "running" || exitRequested) return;
    if (activeRequests.size > 0) return;
    if (shutdownState === "draining" && beforeExit && !backgroundFinished) {
      if (!backgroundStarted) {
        backgroundStarted = true;
        try {
          Promise.resolve(beforeExit()).then(() => {
            backgroundFinished = true;
            finishShutdown();
          }, (error) => forceDisconnect(`后台落盘失败：${formatError(error)}`));
        } catch (error) { forceDisconnect(`后台落盘失败：${formatError(error)}`); }
      }
      return;
    }
    shutdownState = "stopped";
    // server.close() 在旧版 Node 上可能保留空闲 keep-alive 连接。
    server.closeIdleConnections?.();
    requestExit(0);
  };

  const forceDisconnect = (reason) => {
    if (shutdownState === "forcing" || shutdownState === "stopped") {
      return "forcing";
    }

    shutdownState = "forcing";
    clearActiveTimer(graceTimer);
    const streamCount = activeStreamingResponses.size;
    const socketCount = activeClientSockets.size;
    log(
      `[lite-ccswitch] ${reason}，执行强制断开：正在销毁 ${streamCount} 个流式响应和 ${socketCount} 个客户端连接。`,
    );

    for (const res of activeStreamingResponses) {
      if (!res.destroyed) res.destroy();
    }
    activeStreamingResponses.clear();

    for (const socket of activeClientSockets) {
      if (!socket.destroyed) socket.destroy();
    }
    activeRequests.clear();
    activeClientSockets.clear();
    server.closeAllConnections?.();

    forcedExitTimer = startTimer(
      () => requestExit(1),
      FORCED_SHUTDOWN_EXIT_MS,
    );
    return "forcing";
  };

  const requestShutdown = (signal) => {
    if (shutdownState !== "running") {
      return forceDisconnect(`收到第二次 ${signal}（二次断开）`);
    }

    shutdownState = "draining";
    onDraining();
    const graceMessage = graceMs > 0
      ? `（最长 ${graceMs}ms，超时后强制断开）`
      : "（不设强制截止时间）";
    log(
      `[lite-ccswitch] 收到 ${signal}，停止接收新请求并等待已有连接完成${graceMessage}。再次发送 SIGTERM 或 SIGINT 将立即强制断开所有连接。`,
    );
    if (graceMs > 0) {
      graceTimer = startTimer(
        () => forceDisconnect("关闭宽限期已到"),
        graceMs,
      );
    }

    try {
      // 先关闭空闲 keep-alive 连接，再等待 server.close 回调；否则 Node 可能
      // 一直把空闲客户端连接视为活动连接，导致优雅退出永远无法完成。
      server.closeIdleConnections?.();
      server.close(finishShutdown);
      finishShutdown();
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") {
        finishShutdown();
      } else {
        forceDisconnect(`停止监听失败：${formatError(error)}`);
      }
    }
    return "draining";
  };

  return {
    requestShutdown,
    requestFinished: finishShutdown,
    state: () => shutdownState,
  };
}

function formatError(error) {
  if (error?.name === "AbortError") return "请求超时或被中断";
  return error instanceof Error ? error.message : String(error);
}
