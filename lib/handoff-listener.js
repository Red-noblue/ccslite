/**
 * 中文固定交接监听器：持有公开主端口和分组端口，把请求转发到当前私有工作进程。
 * 交接期间使用请求队列；状态接口做公开端口修正，业务流和取消信号保持透传。
 */
import { responseContextScope } from "./handoff-session.js";
import http from "node:http";
import crypto from "node:crypto";
import { finished } from "node:stream/promises";
import { createHandoffQueue } from "./handoff-queue.js";
import { createAccessControl } from "./access-control.js";
import { isProxyRoute, parseProviderRoute } from "./upstream-request.js";
import { createGroupListeners } from "./group-listeners.js";
import {
  createHandoffSessionRegistry,
  encodeHandoffResponseContext,
  extractSessionKey,
} from "./handoff-session.js";

function responseError(res, error) {
  if (res.headersSent || res.destroyed) return;
  if (error.retryAfter !== undefined) res.setHeader("retry-after", String(error.retryAfter));
  res.writeHead(Number(error.status) || 502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: error.message, type: error.code || "handoff_error" } }));
}

async function readBody(req, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("请求体超过升级交接缓冲上限"), { status: 413, code: "handoff_body_too_large" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createHandoffListener({ host = "127.0.0.1", mainPort, groups = [], maxBodyBytes = 200 * 1024 * 1024,
  proxyToken = "", adminToken = proxyToken, getRuntimeState = () => ({}), queueOptions = {}, onEvent = () => {} }) {
  if (!Number.isInteger(mainPort)) throw new TypeError("交接主端口必须是整数");
  const publicGroups = new Map(groups.map((group) => [group.id, { ...group, port: Number(group.port) }]));
  let publicListeners = null;
  const statusStreams = new Set();
  let target = null;
  const sessionRegistry = createHandoffSessionRegistry();
  const legacyTargets = new Map();
  const sessionRequests = new Map();
  const sessionRequestKey = (sessionKey, requestId) => JSON.stringify([sessionKey, String(requestId || "")]);
  let handoffMode = "process";
  let adminPaused = false;
  let closed = false;
  let statusBridge = null; let statusRetry = null;
  const loopback = (address) => ["127.0.0.1", "localhost", "::1"].includes(address);
  const access = (address) => createAccessControl({ isLoopback: loopback(address), proxyToken, adminToken });
  const adminAccess = access(host);
  const queue = createHandoffQueue({ ...queueOptions, onEvent });
  // 管理修改单独排队，配置交接不阻塞正在输出的业务流。
  const adminQueue = createHandoffQueue({ ...queueOptions, onEvent: (event) => onEvent({ ...event, queue: "admin" }) });
  const resumeAdminWrites = () => { if (!adminPaused) adminQueue.activate((request) => forward(target, request)); };

  const workerPort = (worker, groupId) => groupId === "default" ? worker.mainPort : worker.groups?.[groupId];
  const forward = (worker, request) => new Promise((resolve, reject) => {
    const port = workerPort(worker, request.groupId);
    if (!Number.isInteger(port)) {
      reject(Object.assign(new Error(`工作进程没有分组 ${request.groupId} 的私有端口`), { status: 503, code: "worker_group_unavailable" })); return;
    }
    if (request.sessionKey) request._handoffForwardedWorker = workerIdentity(worker);
    const upstream = http.request({ host: "127.0.0.1", port, method: request.method, path: request.path,
      headers: { ...request.headers, host: `127.0.0.1:${port}`, "content-length": request.body.length } }, (response) => resolve(response));
    const abort = () => upstream.destroy(Object.assign(new Error("客户端已取消交接请求"), { code: "client_cancelled", status: 499 }));
    request.signal?.addEventListener("abort", abort, { once: true });
    upstream.once("error", reject);
    upstream.once("close", () => request.signal?.removeEventListener("abort", abort));
    if (request.signal?.aborted) { abort(); return; }
    upstream.end(request.body);
  });

  const workerIdentity = (worker) => `${worker?.id || ""}:${worker?.pid || ""}`;
  const workerForCheckpoint = (workerId, workerPid) => {
    const identity = `${workerId || ""}:${workerPid || ""}`;
    if (workerIdentity(target) === identity) return target;
    return [...legacyTargets.values()].find((worker) => workerIdentity(worker) === identity) || null;
  };
  const sessionRequest = (request) => {
    const payload = (() => { try { return JSON.parse(request.body?.toString("utf8") || "{}"); } catch { return {}; } })();
    const session = extractSessionKey(request.headers, request.body, payload.model || payload.model_name || "", request.routeKey || "cct", request.groupId);
    request.contextScope = responseContextScope(request.groupId, request.routeKey, payload.model || payload.model_name || "");
    request.sessionKey = session.key;
    request.previousResponseId = session.previousResponseId;
    delete request.headers["x-lite-handoff-response-context"];
    delete request.headers["x-lite-handoff-session-key"];
    if (session.key) request.headers["x-lite-handoff-session-key"] = session.key;
    const responseContext = sessionRegistry.resolveResponseContext(session.previousResponseId, payload.model || payload.model_name || "", request.contextScope);
    const encodedContext = responseContext
      ? encodeHandoffResponseContext(responseContext.providerId, responseContext.fallbackProviderIds)
      : "";
    if (encodedContext) request.headers["x-lite-handoff-response-context"] = encodedContext;
    request._handoffOwner = sessionRegistry.beginRequest({ sessionKey: session.key, previousResponseId: session.previousResponseId, scope: request.contextScope });
    request.sessionRequestKey = sessionRequestKey(session.key, request.headers["x-request-id"]);
    sessionRequests.set(request.sessionRequestKey, request);
    return request;
  };

  const publicGroup = (group) => {
    const configured = group.id === "default" ? { host, port: mainPort } : publicGroups.get(group.id);
    const enabled = group.listener?.enabled !== false;
    const actualListener = enabled ? publicListeners?.status(group.id).actualListener || null : null;
    return { ...group, listener: { ...group.listener, ...(configured ? { host: configured.host || host, port: configured.port } : {}) },
      actualListener, listenerStatus: actualListener ? "listening" : "not_listening" };
  };
  const publicPayload = (value, pathname) => {
    if (pathname === "/api/groups") return Array.isArray(value) ? value.map(publicGroup) : publicGroup(value);
    if (/^\/api\/groups\/[^/]+(?:\/clone)?$/.test(pathname)) return publicGroup(value);
    const payload = { ...value };
    if (Array.isArray(payload.groups)) payload.groups = payload.groups.map(publicGroup);
    if (pathname !== "/api/status") return payload;
    payload.address = host; payload.port = mainPort; payload.publicPort = mainPort;
    payload.security = { ...payload.security, loopbackOnly: loopback(host) };
    payload.handoff = { ...payload.handoff, ...getRuntimeState(), listener: "fixed", queue: queue.stats(), workerPid: target?.pid || null };
    return payload;
  };
  const publicJson = async (response, pathname) => {
    if (response.statusCode < 200 || response.statusCode >= 300 || !String(response.headers["content-type"]).includes("application/json")) return response;
    const chunks = []; let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBodyBytes) throw new Error("管理响应超过交接缓冲上限");
      chunks.push(chunk);
    }
    const body = Buffer.from(JSON.stringify(publicPayload(JSON.parse(Buffer.concat(chunks).toString()), pathname)));
    const headers = { ...response.headers, "content-type": "application/json", "cache-control": "no-store" };
    delete headers["content-length"]; delete headers["transfer-encoding"];
    return { statusCode: response.statusCode, headers, body };
  };
  const stopStatusBridge = () => {
    clearTimeout(statusRetry); statusRetry = null;
    statusBridge?.controller.abort(); statusBridge = null;
  };
  const restartStatusBridge = () => {
    stopStatusBridge();
    if (closed || !target || !statusStreams.size) return;
    const bridge = { controller: new AbortController() }; statusBridge = bridge;
    bridge.done = (async () => {
      const response = await forward(target, { groupId: "default", method: "GET", path: "/api/status/events", body: Buffer.alloc(0),
        headers: adminToken ? { "x-lite-ccswitch-token": adminToken } : {}, signal: bridge.controller.signal });
      if (response.statusCode !== 200) { response.destroy(); throw new Error(`工作进程状态流返回 HTTP ${response.statusCode}`); }
      const decoder = new TextDecoder(); let pending = "";
      for await (const chunk of response) {
        if (statusBridge !== bridge || bridge.controller.signal.aborted) break;
        pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        if (Buffer.byteLength(pending) > maxBodyBytes) throw new Error("状态流事件超过缓冲上限");
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const lines = frame.split("\n");
          if (!lines.some((line) => line === "event: status")) continue;
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          const output = `event: status\ndata: ${JSON.stringify(publicPayload(JSON.parse(data), "/api/status"))}\n\n`;
          for (const res of statusStreams) {
            if (res.writableLength > maxBodyBytes) res.destroy();
            else if (!res.destroyed) res.write(output);
          }
        }
      }
    })().catch((error) => {
      if (!bridge.controller.signal.aborted) onEvent({ event: "handoff_status_stream_error", message: error.message });
    }).finally(() => {
      if (statusBridge === bridge) {
        statusBridge = null;
        if (!closed && statusStreams.size) statusRetry = setTimeout(restartStatusBridge, 1000);
      }
    });
  };
  const openStatusStream = async (request, res) => {
    const initial = await publicJson(await forward(target, { ...request, path: request.path.replace(/\/events(?=\?|$)/, "") }), "/api/status");
    if (initial.statusCode !== 200) return initial;
    if (res.destroyed) return null;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
    res.write(`retry: 1000\n\nevent: status\ndata: ${initial.body.toString()}\n\n`);
    statusStreams.add(res);
    if (!statusBridge) restartStatusBridge();
    try { await finished(res, { cleanup: true }); }
    finally { statusStreams.delete(res); if (!statusStreams.size) stopStatusBridge(); }
    return null;
  };

  const handle = async (req, res, groupId) => {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    let request = null;
    req.once("aborted", abort); res.once("close", abort);
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (groupId !== "default" && !isProxyRoute(pathname)) {
        responseError(res, Object.assign(new Error("此端口仅提供分组代理，请通过主服务端口管理分组。"), { status: 404, code: "group_proxy_only" })); return;
      }
      if (groupId === "default" && pathname.startsWith("/api/")) {
        if (await adminAccess.handleAuth(req, res, pathname) || !adminAccess.assertAdmin(req, res)) return;
      } else if (isProxyRoute(pathname)) {
        const address = groupId === "default" ? host : publicGroups.get(groupId)?.host || host;
        if (!access(address).assertProxy(req, res)) return;
      }
      if (queue.state() === "closed") throw queue.failure();
      if (!target) throw Object.assign(new Error("暂无可服务版本"), { status: 503, code: "handoff_no_worker", retryAfter: 1 });
      const body = await readBody(req, queue.state() === "open" ? maxBodyBytes : Math.min(maxBodyBytes, queueOptions.maxBytes ?? 16 * 1024 * 1024));
      request = { method: req.method || "GET", path: req.url, headers: { ...req.headers }, body, signal: abortController.signal, groupId };
      request.headers["x-request-id"] = request.headers["x-request-id"] || crypto.randomUUID();
      request.routeKey = parseProviderRoute(pathname).routeKey;
      const adminWrite = groupId === "default" && pathname.startsWith("/api/") && !["GET", "HEAD"].includes(req.method);
      // 交接前也登记业务会话，候选切换时才能知道哪些会话已经在旧版本中进行。
      if (isProxyRoute(pathname)) sessionRequest(request);
      let response = adminWrite ? await adminQueue.route(request)
        : groupId === "default" && req.method === "GET" && pathname === "/api/status/events"
        ? await openStatusStream(request, res)
        : groupId === "default" && req.method === "GET" && pathname === "/api/status"
        ? await forward(target, request)
        : handoffMode === "session" && isProxyRoute(pathname) && queue.state() === "open"
        ? await forward(request._handoffOwner || target, request)
        : await queue.route(request);
      if (!response || res.destroyed) return;
      if (groupId === "default" && (pathname === "/api/status" || pathname === "/api/config" || /^\/api\/groups(?:\/|$)/.test(pathname)))
        response = await publicJson(response, pathname);
      res.writeHead(response.statusCode, response.headers);
      if (response.body) res.end(response.body);
      else {
        const onError = (error) => res.destroy(error);
        response.once("error", onError);
        try { response.pipe(res); await finished(res, { cleanup: true }); }
        finally { response.off("error", onError); }
      }
      // 即使当前是整体交接模式，也要结束此前登记的请求；否则旧版本会被
      // 误认为仍有活动会话，观察期永远无法退役旧进程。
      if (request.sessionKey) {
        request._handoffNetworkFinished = true;
        request._handoffAwaitingCheckpoint = request._handoffCompleted !== true && response.statusCode >= 200 && response.statusCode < 400;
        sessionRegistry.finishRequest({ sessionKey: request.sessionKey, worker: request._handoffOwner || target, completed: request._handoffCompleted === true,
          pendingRequestId: request._handoffAwaitingCheckpoint ? request.headers["x-request-id"] : "" });
      }
    } catch (error) {
      if (request?.sessionKey) sessionRegistry.finishRequest({ sessionKey: request.sessionKey, worker: request._handoffOwner || target, completed: false });
      responseError(res, error);
    }
    finally {
      if (request?.sessionRequestKey) {
        const id = request.sessionRequestKey;
        if (request._handoffAwaitingCheckpoint) sessionRequests.set(id, { sessionKey: request.sessionKey, _handoffNetworkFinished: true,
          _handoffForwardedWorker: request._handoffForwardedWorker });
        else sessionRequests.delete(id);
      }
      statusStreams.delete(res); req.off("aborted", abort); res.off("close", abort);
    }
  };

  return {
    queue,
    adminQueue,
    async pauseAdminWrites() {
      adminPaused = true;
      adminQueue.beginDrain();
      // 已经发往旧进程的管理请求必须先得到结果，尚未转发的修改留给接管版本。
      while (adminQueue.stats().inFlight > 0) {
        if (closed) throw new Error("交接监听器已经关闭");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    resumeAdminWrites() { adminPaused = false; resumeAdminWrites(); },
    setTarget(worker) { if (closed) throw new Error("交接监听器已经关闭"); target = worker; sessionRegistry.registerWorker(worker, "active"); handoffMode = "process"; queue.activate((request) => forward(target, request)); resumeAdminWrites(); restartStatusBridge(); onEvent({ event: "handoff_target_set", worker: worker.id, pid: worker.pid || null }); },
    dispatch(worker, request) { return forward(worker, request); },
    beginSessionHandoff(oldWorker, newWorker) {
      if (closed) throw new Error("交接监听器已经关闭");
      legacyTargets.set(workerIdentity(oldWorker), oldWorker);
      target = newWorker;
      sessionRegistry.beginHandoff(oldWorker, newWorker);
      handoffMode = "session";
      resumeAdminWrites();
      restartStatusBridge();
      onEvent({ event: "handoff_session_switching", oldWorker: oldWorker.id, worker: newWorker.id, session: sessionRegistry.state() });
    },
    checkpoint({ workerId, workerPid, sessionKey, responseIds = [], completed = false, requestId = "",
      providerId = "", fallbackProviderIds = [], model = "" }) {
      const worker = workerForCheckpoint(workerId, workerPid);
      if (!worker) return false;
      const key = sessionRequestKey(sessionKey, requestId);
      const request = sessionRequests.get(key);
      const accepted = sessionRegistry.checkpoint({
        worker, sessionKey, responseIds, completed, providerId, fallbackProviderIds, model, requestId,
        // 整体交接中排队请求可能在旧版登记、实际由新版处理；只接受确实转发给该进程的完成确认。
        allowCompletedRequest: handoffMode === "process" && request?._handoffForwardedWorker === workerIdentity(worker),
      });
      if (accepted && request) {
        request._handoffCompleted = Boolean(completed);
        if (completed) request._handoffAwaitingCheckpoint = false;
        if (request._handoffNetworkFinished && completed) sessionRequests.delete(key);
      }
      if (accepted && sessionRegistry.state().legacySessionCount === 0) onEvent({ event: "handoff_sessions_drained", worker: worker.id, session: sessionRegistry.state() });
      return accepted;
    },
    updateResponseContexts({ workerId, workerPid, changes = [] }) {
      const worker = workerForCheckpoint(workerId, workerPid);
      if (!worker) throw new Error("响应上下文来源工作进程已经退役");
      if (!Array.isArray(changes) || changes.length > 256) throw new Error("响应上下文变更数量超出上限");
      return sessionRegistry.updateResponseContexts(worker, changes);
    },
    sessionState() { return sessionRegistry.state(); },
    resolveResponseContext(responseId, model = "", scope = responseContextScope("default", "cct", model)) {
      return sessionRegistry.resolveResponseContext(responseId, model, scope);
    },
    // 整体交接不按会话注册表等待；注册表里的历史客户端身份不应阻止旧进程退役。
    // 只有会话级并行交接才需要等待旧会话和其活动请求清零。
    canRetireWorker(worker) {
      const state = sessionRegistry.state();
      if (state.mode !== "session") return true;
      return state.legacySessionCount === 0 && state.inFlightSessions === 0;
    },
    retireWorker(worker) { sessionRegistry.retireWorker(worker); legacyTargets.delete(workerIdentity(worker)); },
    beginDrain() { queue.beginDrain(); },
    resumeRequests() { queue.activate((request) => forward(handoffMode === "session" ? request._handoffOwner || target : target, request)); },
    activate(worker) { this.setTarget(worker); },
    target: () => target,
    group: (id) => publicGroups.get(id),
    groups: () => [...publicGroups.values()],
    async applyGroup(group) {
      if (closed || !publicListeners) throw new Error("固定监听器尚未启动或已经关闭");
      if (group.id === "default") return;
      await publicListeners.apply(group);
      publicGroups.set(group.id, { id: group.id, ...group.listener });
    },
    async forgetGroup(id) {
      const previous = publicGroups.get(id);
      if (!previous) return;
      await this.applyGroup({ id, listener: { ...previous, enabled: false } }); publicGroups.delete(id);
    },
    async listen() {
      const main = http.createServer((req, res) => void handle(req, res, "default"));
      main.requestTimeout = 0; main.headersTimeout = 65_000;
      publicListeners = createGroupListeners({ mainServer: main, mainPort, handleRequest: handle });
      await new Promise((resolve, reject) => { main.once("error", reject); main.listen(mainPort, host, resolve); });
      for (const group of publicGroups.values()) {
        try { await publicListeners.apply({ id: group.id, listener: { host: group.host || host, port: group.port, enabled: group.enabled !== false } }); }
        catch (error) { await this.close(); throw error; }
      }
    },
    forceClose() { publicListeners?.closeAllConnections(); },
    async close(error) {
      closed = true; queue.close(error); adminQueue.close(error);
      stopStatusBridge();
      for (const res of statusStreams) res.end();
      if (publicListeners) await new Promise((resolve) => publicListeners.close(resolve));
    },
  };
}
