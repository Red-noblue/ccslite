/**
 * 供应商配置归一化模块。
 * 负责旧开关迁移、字段更新、排序和对管理接口输出的敏感信息脱敏。
 */

import crypto from "node:crypto";
import {
  applyManualModelSupport,
  normalizeModelSupport,
} from "./model-support.js";
import { compareProviders } from "./provider-order.js";

export { compareProviders } from "./provider-order.js";

const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
const MIN_SESSION_TTL_MS = 60_000;
const MAX_SESSION_TTL_MS = 60 * 60_000;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// 新开关优先；读取旧配置时，仅当“启用”和“加入故障转移”同时成立才参与自动路由。
export function resolveProviderRoutingEnabled(payload = {}, fallback = true) {
  if (Object.prototype.hasOwnProperty.call(payload, "routingEnabled")) {
    return Boolean(payload.routingEnabled);
  }
  const hasEnabled = Object.prototype.hasOwnProperty.call(payload, "enabled");
  const hasFailover = Object.prototype.hasOwnProperty.call(payload, "inFailoverQueue");
  if (!hasEnabled && !hasFailover) return Boolean(fallback);
  const enabled = hasEnabled ? Boolean(payload.enabled) : Boolean(fallback);
  const inFailoverQueue = hasFailover
    ? Boolean(payload.inFailoverQueue)
    : Boolean(fallback);
  return enabled && inFailoverQueue;
}

export function setProviderRoutingEnabled(provider, routingEnabled) {
  const next = Boolean(routingEnabled);
  provider.routingEnabled = next;
  provider.enabled = next;
  provider.inFailoverQueue = next;
}

export function isProviderInAutoRouting(provider) {
  return resolveProviderRoutingEnabled(provider, false);
}

export function createProvider(payload = {}, defaultSortIndex = 1) {
  const id = String(payload.id || crypto.randomUUID());
  const routingEnabled = resolveProviderRoutingEnabled(payload, true);
  const authMode = normalizeAuthMode(payload.authMode ?? payload.auth_mode);
  return {
    id,
    name: String(payload.name || "未命名供应商"),
    baseUrl: normalizeBaseUrl(payload.baseUrl || payload.base_url || ""),
    proxyUrl: normalizeProxyUrl(payload.proxyUrl ?? payload.proxy_url ?? payload.proxyPort),
    apiKey: String(payload.apiKey || payload.api_key || ""),
    authMode,
    upstreamMode: normalizeUpstreamMode(payload.upstreamMode ?? payload.upstream_mode),
    oauthFilePath: normalizeOAuthFilePath(payload.oauthFilePath ?? payload.oauth_file_path),
    sessionHeaders: normalizeSessionHeaders(payload.sessionHeaders ?? payload.session_headers),
    sessionTtlMs: normalizeSessionTtlMs(payload.sessionTtlMs ?? payload.session_ttl_ms),
    routingEnabled,
    enabled: routingEnabled,
    inFailoverQueue: routingEnabled,
    sortIndex: positiveInt(payload.sortIndex, defaultSortIndex),
    notes: String(payload.notes || ""),
    modelMap: normalizeObject(payload.modelMap),
    modelSupport: normalizeModelSupport(payload.modelSupport || payload.model_support),
    stripParams: Array.isArray(payload.stripParams)
      ? payload.stripParams.map(String)
      : [],
    customHeaders: normalizeObject(payload.customHeaders),
  };
}

export function updateProvider(provider, payload = {}) {
  if (payload.name !== undefined) provider.name = String(payload.name);
  if (payload.baseUrl !== undefined || payload.base_url !== undefined) {
    provider.baseUrl = normalizeBaseUrl(payload.baseUrl || payload.base_url || "");
  }
  if (
    payload.proxyUrl !== undefined ||
    payload.proxy_url !== undefined ||
    payload.proxyPort !== undefined
  ) {
    provider.proxyUrl = normalizeProxyUrl(
      payload.proxyUrl ?? payload.proxy_url ?? payload.proxyPort,
    );
  }
  if (payload.apiKey !== undefined || payload.api_key !== undefined) {
    const nextKey = payload.apiKey !== undefined ? payload.apiKey : payload.api_key;
    provider.apiKey = String(nextKey ?? "");
  }
  if (payload.authMode !== undefined || payload.auth_mode !== undefined) {
    provider.authMode = normalizeAuthMode(payload.authMode ?? payload.auth_mode);
  }
  if (payload.upstreamMode !== undefined || payload.upstream_mode !== undefined) {
    provider.upstreamMode = normalizeUpstreamMode(payload.upstreamMode ?? payload.upstream_mode);
  }
  if (payload.oauthFilePath !== undefined || payload.oauth_file_path !== undefined) {
    provider.oauthFilePath = normalizeOAuthFilePath(
      payload.oauthFilePath ?? payload.oauth_file_path,
    );
  }
  if (payload.sessionHeaders !== undefined || payload.session_headers !== undefined) {
    provider.sessionHeaders = normalizeSessionHeaders(
      payload.sessionHeaders ?? payload.session_headers,
    );
  }
  if (payload.sessionTtlMs !== undefined || payload.session_ttl_ms !== undefined) {
    provider.sessionTtlMs = normalizeSessionTtlMs(
      payload.sessionTtlMs ?? payload.session_ttl_ms,
    );
  }
  if (
    payload.routingEnabled !== undefined ||
    payload.enabled !== undefined ||
    payload.inFailoverQueue !== undefined
  ) {
    setProviderRoutingEnabled(
      provider,
      resolveProviderRoutingEnabled(payload, isProviderInAutoRouting(provider)),
    );
  }
  if (payload.sortIndex !== undefined) {
    provider.sortIndex = positiveInt(payload.sortIndex, provider.sortIndex);
  }
  if (payload.notes !== undefined) provider.notes = String(payload.notes || "");
  if (payload.modelMap !== undefined) provider.modelMap = normalizeObject(payload.modelMap);
  if (payload.modelSupport !== undefined || payload.model_support !== undefined) {
    const modelSupport = payload.modelSupport || payload.model_support;
    provider.modelSupport = Object.prototype.hasOwnProperty.call(modelSupport || {}, "modelEvidence") ||
      Object.prototype.hasOwnProperty.call(modelSupport || {}, "model_evidence")
      ? normalizeModelSupport(modelSupport)
      : applyManualModelSupport(provider.modelSupport, modelSupport);
  }
  if (payload.customHeaders !== undefined) {
    provider.customHeaders = normalizeObject(payload.customHeaders);
  }
  if (payload.stripParams !== undefined) {
    provider.stripParams = Array.isArray(payload.stripParams)
      ? payload.stripParams.map(String)
      : [];
  }
  return provider;
}

export function sanitizeProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    proxyUrl: provider.proxyUrl || "",
    routingEnabled: isProviderInAutoRouting(provider),
    enabled: isProviderInAutoRouting(provider),
    inFailoverQueue: isProviderInAutoRouting(provider),
    sortIndex: provider.sortIndex,
    notes: provider.notes,
    hasApiKey: Boolean(provider.apiKey),
    apiKeyMasked: maskSecret(provider.apiKey),
    authMode: normalizeAuthMode(provider.authMode),
    upstreamMode: normalizeUpstreamMode(provider.upstreamMode),
    oauthFilePath: normalizeOAuthFilePath(provider.oauthFilePath),
    sessionHeaders: normalizeSessionHeaders(provider.sessionHeaders),
    sessionTtlMs: normalizeSessionTtlMs(provider.sessionTtlMs),
    modelMap: provider.modelMap || {},
    modelSupport: normalizeModelSupport(provider.modelSupport),
    stripParams: provider.stripParams || [],
    customHeaders: maskHeaders(provider.customHeaders || {}),
  };
}

export function sortProviders(providers) {
  return providers.sort(compareProviders);
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// 代理支持 HTTP/HTTPS URL，也支持直接填写本机端口，例如 7890。
function normalizeProxyUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\d+$/.test(text)) {
    const port = Number(text);
    return port >= 1 && port <= 65535 ? `http://127.0.0.1:${port}` : "";
  }
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function normalizeAuthMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "client_session") return "client_session";
  if (["oauth_file", "auth_file", "dynamic_oauth_file"].includes(normalized)) {
    return "oauth_file";
  }
  return "api_key";
}

function normalizeUpstreamMode(value) {
  return String(value || "").trim().toLowerCase() === "codex_oauth"
    ? "codex_oauth"
    : "openai_compatible";
}

function normalizeOAuthFilePath(value) {
  return String(value || "").trim();
}

function normalizeSessionHeaders(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((name) => HEADER_NAME_PATTERN.test(name)))];
}

function normalizeSessionTtlMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_TTL_MS;
  return Math.min(MAX_SESSION_TTL_MS, Math.max(MIN_SESSION_TTL_MS, Math.floor(parsed)));
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function maskHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    result[key] = /key|token|authorization|secret/i.test(key)
      ? maskSecret(value)
      : value;
  }
  return result;
}
