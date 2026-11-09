/**
 * 中文会话交接注册表：只保存脱敏后的会话摘要、工作进程归属和响应别名。
 * 它不保存 Authorization、OAuth 令牌或请求正文，用于前置器决定请求应交给哪个版本。
 */
import crypto from "node:crypto";

const SESSION_HEADERS = [
  "x-codex-session-id",
  "x-codex-conversation-id",
  "x-openai-conversation-id",
  "x-conversation-id",
  "conversation-id",
  "x-session-id",
  "session-id",
  "x-thread-id",
  "thread-id",
  "x-client-session-id",
  "prompt-cache-key",
];
const SESSION_FIELDS = [
  "prompt_cache_key",
  "promptCacheKey",
  "conversation_id",
  "conversationId",
  "session_id",
  "sessionId",
  "thread_id",
  "threadId",
];
const PREVIOUS_RESPONSE_FIELDS = ["previous_response_id", "previousResponseId"];
const MAX_VALUE_LENGTH = 512;
const MAX_FALLBACK_PROVIDERS = 32;
const MAX_PROVIDER_CONTEXT_HEADER_LENGTH = 8 * 1024;

function normalize(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, MAX_VALUE_LENGTH) : "";
}

function parseBody(body) {
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  try { return JSON.parse(Buffer.from(body || []).toString("utf8")); } catch { return null; }
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function headerMap(headers = {}) {
  return new Map(Object.entries(headers).map(([name, value]) => [
    String(name).toLowerCase(), Array.isArray(value) ? value[0] : value,
  ]));
}

function bodyField(payload, fields) {
  for (const field of fields) {
    const value = normalize(payload?.[field] ?? payload?.metadata?.[field]);
    if (value) return value;
  }
  return "";
}

/** 提取稳定会话标识；返回的 key 只包含摘要，不包含原始会话值。 */
export function extractSessionKey(headers = {}, body = null, model = "", routeKey = "cct", groupId = "default") {
  const map = headerMap(headers);
  let source = "";
  let value = "";
  for (const name of SESSION_HEADERS) {
    value = normalize(map.get(name));
    if (value) { source = `header:${name}`; break; }
  }
  const payload = parseBody(body);
  if (!value) {
    value = bodyField(payload, SESSION_FIELDS);
    if (value) source = "body:session";
  }
  // 没有显式会话头时，仅在客户端身份足够稳定时归组；不把所有匿名请求错误合并。
  if (!value) {
    const identity = [map.get("user-agent"), map.get("origin"), map.get("host"), map.get("authorization")]
      .map(normalize).filter(Boolean).join("|");
    if (identity) { value = identity; source = "client_identity"; }
  }
  if (!value) return { key: "", source: "", previousResponseId: extractPreviousResponseId(body), eligible: false };
  const normalizedModel = normalize(model) || "unknown";
  return {
    key: `${normalize(groupId) || "default"}:${normalize(routeKey) || "cct"}:${normalizedModel}:${digest(value)}`,
    source,
    previousResponseId: extractPreviousResponseId(body),
    eligible: true,
  };
}

/** 提取 previous_response_id，但永远不在注册表中保存请求正文。 */
export function extractPreviousResponseId(body) {
  const payload = parseBody(body);
  return normalize(PREVIOUS_RESPONSE_FIELDS.map((field) => payload?.[field]).find(Boolean));
}

function workerKey(worker) {
  if (!worker) return "";
  return String(worker.generation || worker.id || "") + (worker.pid ? `:${worker.pid}` : "");
}

function normalizeProviderContext(providerId, fallbackProviderIds = []) {
  const primary = normalize(providerId);
  if (!primary) return null;
  const fallbacks = [...new Set((Array.isArray(fallbackProviderIds) ? fallbackProviderIds : [])
    .map(normalize).filter((id) => id && id !== primary))]
    .slice(0, MAX_FALLBACK_PROVIDERS);
  return { providerId: primary, fallbackProviderIds: fallbacks };
}

export function encodeHandoffResponseContext(providerId, fallbackProviderIds = []) {
  const context = normalizeProviderContext(providerId, fallbackProviderIds);
  return context ? Buffer.from(JSON.stringify(context)).toString("base64url") : "";
}

export function decodeHandoffResponseContext(value) {
  const encoded = Array.isArray(value) ? value[0] : value;
  if (typeof encoded !== "string" || !encoded || encoded.length > MAX_PROVIDER_CONTEXT_HEADER_LENGTH) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return normalizeProviderContext(parsed?.providerId, parsed?.fallbackProviderIds);
  } catch {
    return null;
  }
}

export function responseContextScope(groupId = "default", routeKey = "cct", model = "") {
  return JSON.stringify([normalize(groupId) || "default", normalize(routeKey) || "cct", normalize(model)]);
}
function responseKey(id, scope = "") { return JSON.stringify([scope, normalize(id)]); }

export function createHandoffSessionRegistry({ now = () => Date.now(), ttlMs = 24 * 60 * 60 * 1000, maxEntries = 10_000 } = {}) {
  const workers = new Map();
  const sessions = new Map();
  const responses = new Map();
  let current = null;
  let mode = "process";

  const removeExpired = () => {
    const cutoff = now() - Math.max(1, Number(ttlMs) || 1);
    for (const [key, entry] of sessions) {
      if (entry.updatedAt < cutoff && entry.inFlight === 0 && entry.awaiting.size === 0) sessions.delete(key);
    }
    for (const [id, entry] of responses) {
      if (entry.updatedAt < cutoff || !sessions.has(entry.sessionKey)) responses.delete(id);
    }
  };
  const prune = () => {
    removeExpired();
    while (sessions.size > Math.max(1, Number(maxEntries) || 10_000)) sessions.delete(sessions.keys().next().value);
    while (responses.size > Math.max(1, Number(maxEntries) * 2 || 20_000)) responses.delete(responses.keys().next().value);
  };
  const entryFor = (key, create = false) => {
    if (!key) return null;
    let entry = sessions.get(key);
    if (!entry && create) {
      entry = { sessionKey: key, worker: current, inFlight: 0, awaiting: new Set(), pendingMigration: false, updatedAt: now() };
      sessions.set(key, entry);
    }
    if (entry) entry.updatedAt = now();
    return entry;
  };

  return {
    mode: () => mode,
    current: () => current,
    registerWorker(worker, role = "legacy") {
      const key = workerKey(worker);
      if (!key) throw new TypeError("工作进程必须有 id 或 generation");
      workers.set(key, worker);
      if (role === "active") { current = worker; mode = "process"; }
      return key;
    },
    beginHandoff(oldWorker, newWorker) {
      if (!oldWorker || !newWorker) throw new TypeError("会话交接需要旧版本和候选版本");
      this.registerWorker(oldWorker, "legacy");
      this.registerWorker(newWorker, "active");
      current = newWorker;
      mode = "session";
      for (const entry of sessions.values()) {
        if (entry.worker !== oldWorker) continue;
        if (entry.inFlight === 0 && entry.awaiting.size === 0) {
          entry.worker = newWorker;
          entry.pendingMigration = false;
        } else {
          entry.pendingMigration = true;
        }
      }
      return this.state();
    },
    rollback(failedWorker, oldWorker) {
      this.registerWorker(failedWorker, "legacy");
      this.registerWorker(oldWorker, "active");
      current = oldWorker;
      mode = "session";
      for (const entry of sessions.values()) {
        if (entry.worker === failedWorker || entry.pendingMigration) {
          entry.worker = oldWorker;
          entry.pendingMigration = false;
        }
      }
      return this.state();
    },
    owner({ sessionKey = "", previousResponseId = "", scope = "" } = {}) {
      removeExpired();
      const response = responses.get(responseKey(previousResponseId, scope));
      if (response) {
        const entry = sessions.get(response.sessionKey);
        if (entry?.worker) return entry.worker;
      }
      const entry = sessions.get(sessionKey);
      return entry?.worker || current || null;
    },
    beginRequest({ sessionKey = "", previousResponseId = "", scope = "" } = {}) {
      const worker = this.owner({ sessionKey, previousResponseId, scope });
      const entry = entryFor(sessionKey, Boolean(sessionKey));
      if (entry) { entry.scope = scope; entry.worker ||= worker; entry.inFlight += 1; entry.updatedAt = now(); }
      return worker;
    },
    finishRequest({ sessionKey = "", worker = null, completed = false, pendingRequestId = "" } = {}) {
      const entry = entryFor(sessionKey);
      if (!entry) return false;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (pendingRequestId) entry.awaiting.add(pendingRequestId);
      entry.updatedAt = now();
      if (completed && entry.inFlight === 0 && entry.awaiting.size === 0 && mode === "session" && current && worker && worker !== current) {
        entry.worker = current;
        entry.pendingMigration = false;
        return true;
      }
      return false;
    },
    checkpoint({ sessionKey = "", responseIds = [], worker = null, completed = false,
      providerId = "", fallbackProviderIds = [], model = "", scope = null, requestId = "", allowCompletedRequest = false } = {}) {
      const entry = entryFor(sessionKey, Boolean(sessionKey));
      if (!entry) return false;
      if (worker && entry.worker && entry.worker !== worker && !(allowCompletedRequest && completed)) return false;
      if (!entry.worker || (allowCompletedRequest && worker === current)) entry.worker = worker || current;
      if (completed && requestId) entry.awaiting.delete(requestId);
      if (completed && entry.inFlight === 0 && entry.awaiting.size === 0 && mode === "session" && current && worker && worker !== current) {
        entry.worker = current;
        entry.pendingMigration = false;
      }
      entry.updatedAt = now();
      const providerContext = normalizeProviderContext(providerId, fallbackProviderIds);
      for (const responseId of [...new Set(responseIds.map(normalize).filter(Boolean))]) {
        responses.set(responseKey(responseId, scope ?? entry.scope ?? ""), {
          sessionKey,
          updatedAt: now(),
          model: normalize(model),
          providerId: providerContext?.providerId || "",
          fallbackProviderIds: providerContext?.fallbackProviderIds || [],
        });
      }
      prune();
      return true;
    },
    resolveResponseContext(responseId, model = "", scope = "") {
      removeExpired();
      const response = responses.get(responseKey(responseId, scope));
      if (!response?.providerId) return null;
      const requestedModel = normalize(model);
      if (requestedModel && response.model && requestedModel !== response.model) return null;
      return {
        providerId: response.providerId,
        fallbackProviderIds: [...response.fallbackProviderIds],
      };
    },
    updateResponseContexts(worker, changes = []) {
      removeExpired();
      return changes.map((change) => {
        const item = responses.get(responseKey(change.responseId, change.scope || ""));
        if (!item) return { missing: true };
        const entry = sessions.get(item.sessionKey);
        const context = { providerId: item.providerId, fallbackProviderIds: [...item.fallbackProviderIds] };
        if (!entry || entry.worker !== worker || (change.model && item.model && change.model !== item.model)) return { rejected: true, context };
        const next = normalizeProviderContext(change.providerId, change.fallbackProviderIds);
        if (!next) return { rejected: true, context };
        if (JSON.stringify(context) === JSON.stringify(next)) return { updated: true };
        if (item.providerId !== change.expectedProviderId || JSON.stringify(item.fallbackProviderIds) !== JSON.stringify(change.expectedFallbackProviderIds || [])) return { conflict: true, context };
        Object.assign(item, next, { updatedAt: now() });
        return { updated: true };
      });
    },
    retireWorker(worker) {
      for (const entry of sessions.values()) {
        if (entry.worker !== worker) continue;
        entry.worker = current && current !== worker ? current : null;
        entry.awaiting.clear();
        entry.pendingMigration = false;
      }
      for (const [key, value] of workers) if (value === worker) workers.delete(key);
    },
    state() {
      removeExpired();
      const oldSessions = [...sessions.values()].filter((entry) => entry.worker && entry.worker !== current);
      return {
        mode,
        currentWorker: workerKey(current),
        sessionCount: sessions.size,
        responseAliasCount: responses.size,
        legacyWorkerCount: [...workers.values()].filter((worker) => worker !== current).length,
        legacySessionCount: oldSessions.length,
        inFlightSessions: [...sessions.values()].filter((entry) => entry.inFlight > 0).length,
        pendingMigrations: [...sessions.values()].filter((entry) => entry.pendingMigration).length,
        pendingCheckpoints: [...sessions.values()].reduce((sum, entry) => sum + entry.awaiting.size, 0),
      };
    },
  };
}

