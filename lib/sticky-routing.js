/**
 * 缓存友好的会话粘滞路由。
 * 为同一会话和模型记住最近成功的供应商，并支持在低价供应商确认恢复后迁移粘滞。
 * 所有状态仅保存在进程内存中，不写入密钥、配置或请求正文。
 */

import crypto from "node:crypto";

const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const MAX_ENTRIES = 2_000;
const MAX_RESPONSE_ALIASES = 4_000;
const MAX_CONTEXT_VALUE_LENGTH = 512;

const SESSION_HEADER_NAMES = [
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

const BODY_CONTEXT_FIELDS = [
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

export function createStickyRoutingStore({
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = MAX_ENTRIES,
} = {}) {
  const entries = new Map();
  const responseAliases = new Map();

  function removeExpired() {
    const currentTime = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(key);
    }
    for (const [responseId, alias] of responseAliases) {
      if (alias.expiresAt <= currentTime || !entries.has(alias.key)) {
        responseAliases.delete(responseId);
      }
    }
  }

  function get(key) {
    if (!key) return null;
    removeExpired();
    const entry = entries.get(key);
    if (!entry) return null;
    return { ...entry };
  }

  function resolvePreviousResponse(responseId, model = "") {
    return resolvePreviousResponseContext(responseId, model)?.key || "";
  }

  function resolvePreviousResponseContext(responseId, model = "") {
    const normalized = normalizeContextValue(responseId);
    if (!normalized) return null;
    removeExpired();
    const alias = responseAliases.get(normalized);
    if (!alias) return null;
    const requestedModel = normalizeContextValue(model);
    if (requestedModel && alias.model && alias.model !== requestedModel) return null;
    return {
      key: alias.key || "",
      providerId: alias.providerId || entries.get(alias.key)?.providerId || "",
      // 价格优先迁移后，旧 response_id 可能仍只存在于原供应商；保留顺序回退链。
      fallbackProviderIds: uniqueContextValues(alias.fallbackProviderIds),
    };
  }

  function orderProviders(key, providers) {
    const list = Array.isArray(providers) ? providers.slice() : [];
    const entry = get(key);
    if (!entry || !entry.providerId) return list;
    const stickyIndex = list.findIndex((provider) => provider.id === entry.providerId);
    if (stickyIndex <= 0) return list;
    const [stickyProvider] = list.splice(stickyIndex, 1);
    return [stickyProvider, ...list];
  }

  // 只校正仍指向本次迁移目标的响应别名，不覆盖并发请求后来写入的新供应商。
  function acceptResponseContext(responseId, model, expectedProviderId, context) {
    removeExpired();
    const alias = responseAliases.get(normalizeContextValue(responseId));
    if (!alias || alias.providerId !== expectedProviderId || (model && alias.model !== model) || !context?.providerId) return false;
    alias.providerId = context.providerId;
    alias.fallbackProviderIds = uniqueContextValues(context.fallbackProviderIds).filter((id) => id !== context.providerId);
    return true;
  }

  function rememberSuccess(key, providerId, responseIds = [], model = "") {
    if (!key || !providerId) return false;
    const timestamp = now();
    const normalizedModel = normalizeContextValue(model) || modelFromKey(key);
    entries.delete(key);
    entries.set(key, {
      providerId: String(providerId),
      model: normalizedModel,
      updatedAt: timestamp,
      expiresAt: timestamp + normalizeTtl(ttlMs),
    });
    for (const responseId of uniqueContextValues(responseIds)) {
      responseAliases.delete(responseId);
      responseAliases.set(responseId, {
        key,
        providerId: String(providerId),
        fallbackProviderIds: [],
        model: normalizedModel,
        expiresAt: timestamp + normalizeTtl(ttlMs),
      });
    }
    prune();
    return true;
  }

  function migrateToProvider(providerId, options = {}) {
    const targetProviderId = String(providerId || "");
    if (!targetProviderId) return 0;
    removeExpired();
    const requestedModel = normalizeContextValue(options.model);
    const shouldReplace = typeof options.shouldReplace === "function"
      ? options.shouldReplace
      : () => true;
    const timestamp = now();
    const migratedKeys = new Map();
    let migrated = 0;
    for (const [key, entry] of entries) {
      const entryModel = entry.model || modelFromKey(key);
      if (requestedModel && entryModel !== requestedModel) continue;
      if (entry.providerId === targetProviderId) continue;
      if (!shouldReplace(entry.providerId, { ...entry, model: entryModel }, key)) continue;
      const oldProviderId = entry.providerId;
      migratedKeys.set(key, oldProviderId);
      entries.set(key, {
        ...entry,
        providerId: targetProviderId,
        model: entryModel,
        migratedFromProviderId: oldProviderId,
        migratedAt: new Date(timestamp).toISOString(),
        updatedAt: timestamp,
        expiresAt: timestamp + normalizeTtl(ttlMs),
      });
      migrated += 1;
    }
    // 普通会话条目和 previous_response_id 别名必须保持同一供应商。
    // 只迁移仍指向该条目旧供应商的别名，避免覆盖并发请求刚写入的新归属。
    for (const [responseId, alias] of responseAliases) {
      const oldProviderId = migratedKeys.get(alias.key);
      if (!oldProviderId || (alias.providerId && alias.providerId !== oldProviderId)) continue;
      const updatedAlias = {
        ...alias,
        providerId: targetProviderId,
        fallbackProviderIds: uniqueContextValues([
          oldProviderId,
          ...(alias.fallbackProviderIds || []),
        ]).filter((id) => id !== targetProviderId),
        updatedAt: timestamp,
        expiresAt: timestamp + normalizeTtl(ttlMs),
      };
      responseAliases.set(responseId, updatedAlias);
      options.onAliasMigrated?.({ responseId, model: alias.model || requestedModel,
        expectedProviderId: alias.providerId || oldProviderId,
        expectedFallbackProviderIds: uniqueContextValues(alias.fallbackProviderIds),
        providerId: updatedAlias.providerId, fallbackProviderIds: updatedAlias.fallbackProviderIds });
    }
    prune();
    return migrated;
  }

  function markFailure(key, providerId) {
    if (!key || !providerId) return false;
    const entry = get(key);
    if (!entry || entry.providerId !== String(providerId)) return false;
    entries.delete(key);
    return true;
  }

  function forgetProvider(providerId) {
    const id = String(providerId || "");
    if (!id) return;
    for (const [key, entry] of entries) {
      if (entry.providerId === id) entries.delete(key);
    }
  }

  function prune() {
    removeExpired();
    while (entries.size > Math.max(1, Number(maxEntries) || MAX_ENTRIES)) {
      entries.delete(entries.keys().next().value);
    }
    while (responseAliases.size > MAX_RESPONSE_ALIASES) {
      responseAliases.delete(responseAliases.keys().next().value);
    }
  }

  function stats() {
    removeExpired();
    return { entries: entries.size, responseAliases: responseAliases.size };
  }

  return {
    get,
    orderProviders,
    rememberSuccess,
    migrateToProvider,
    markFailure,
    forgetProvider,
    resolvePreviousResponse,
    resolvePreviousResponseContext,
    acceptResponseContext,
    stats,
  };
}

export function shouldInvalidateSticky(error) {
  if (!error?.retryable) return false;
  const failureClass = String(error.failureClass || "");
  return ![
    "client_cancelled",
    "client_connection_closed",
    "proxy_local",
  ].includes(failureClass);
}

export function extractRoutingContext(req, body, model, routeKey = "cct") {
  if (routeKey !== "cct" || !String(model || "").trim()) {
    return { eligible: false, key: "", source: "", value: "", responseIds: [] };
  }

  const payload = parseJson(body);
  const headers = req?.headers || {};
  const headerMap = new Map(
    Object.entries(headers).map(([name, value]) => [
      String(name).toLowerCase(),
      Array.isArray(value) ? value[0] : value,
    ]),
  );
  for (const name of SESSION_HEADER_NAMES) {
    const value = normalizeContextValue(headerMap.get(name));
    if (value) {
      return buildContext(routeKey, model, `header:${name}`, value, payload);
    }
  }

  for (const field of BODY_CONTEXT_FIELDS) {
    const value = normalizeContextValue(payload?.[field] ?? payload?.metadata?.[field]);
    if (value) {
      return buildContext(routeKey, model, `body:${field}`, value, payload);
    }
  }

  const previousResponseId = firstField(payload, PREVIOUS_RESPONSE_FIELDS);
  if (previousResponseId) {
    return buildContext(routeKey, model, "previous_response", previousResponseId, payload);
  }

  // Codex CLI 在部分版本不发送会话头；此时使用客户端身份摘要，避免保存原始凭据。
  const fallbackIdentity = [
    headerMap.get("x-forwarded-for"),
    headerMap.get("user-agent"),
    headerMap.get("origin"),
    headerMap.get("host"),
    headerMap.get("authorization"),
  ]
    .map(normalizeContextValue)
    .filter(Boolean)
    .join("|") || "anonymous";
  return buildContext(routeKey, model, "client_identity", fallbackIdentity, payload);
}

export function extractResponseIds(responseBody, responseText) {
  const ids = [];
  const add = (value) => {
    const normalized = normalizeContextValue(value);
    if (normalized && !ids.includes(normalized)) ids.push(normalized);
  };

  const bodyPayload = parseJson(responseBody);
  addResponseIdsFromPayload(bodyPayload, add);
  for (const line of String(responseText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    addResponseIdsFromPayload(parseJson(data), add);
  }
  return ids.slice(0, 16);
}

function buildContext(routeKey, model, source, value, payload = null) {
  const normalizedModel = normalizeContextValue(model) || "unknown";
  const normalizedValue = normalizeContextValue(value);
  const digest = sha256(normalizedValue);
  const previousResponseId = firstField(payload, PREVIOUS_RESPONSE_FIELDS) ||
    (source === "previous_response" ? normalizedValue : "");
  return {
    eligible: Boolean(normalizedValue),
    key: normalizedValue
      ? `${routeKey}:${normalizedModel}:${digest}`
      : "",
    source,
    value: source === "previous_response" ? normalizedValue : "",
    previousResponseId,
    responseIds: extractResponseIdsFromPayload(payload),
  };
}

function extractResponseIdsFromPayload(payload) {
  const ids = [];
  addResponseIdsFromPayload(payload, (value) => {
    if (!ids.includes(value)) ids.push(value);
  });
  return ids;
}

function addResponseIdsFromPayload(payload, add) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  add(payload.id);
  add(payload.response?.id);
  add(payload.item?.id);
}

function firstField(payload, fields) {
  for (const field of fields) {
    const value = normalizeContextValue(payload?.[field]);
    if (value) return value;
  }
  return "";
}

function parseJson(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(Buffer.from(value || []).toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeContextValue(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, MAX_CONTEXT_VALUE_LENGTH) : "";
}

function uniqueContextValues(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeContextValue).filter(Boolean))];
}

function normalizeTtl(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function modelFromKey(key) {
  const parts = String(key || "").split(":");
  return normalizeContextValue(parts[1]);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}
