/**
 * 上游请求构造模块。
 * 负责代理路由识别、URL 拼接、请求头复制和供应商请求体改写。
 */

import { HOP_BY_HOP_HEADERS } from "./http-utils.js";
import { isOAuthFileAuth, readOAuthFileHeaders } from "./oauth-file-source.js";
import { nonRetryableError } from "./proxy-errors.js";

const PROVIDER_ROUTE_PREFIXES = [
  ["/plus", "plus"],
];

export async function buildUpstreamHeaders(clientReq, provider) {
  const headers = new Headers();
  const sessionHeaders = new Set(
    provider?.authMode === "client_session" ? provider.sessionHeaders || [] : [],
  );
  const oauthFileHeaders = isOAuthFileAuth(provider)
    ? await readOAuthFileHeaders(provider)
    : null;
  const sessionValues = {};
  for (const [key, value] of Object.entries(clientReq.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    // 网关访问令牌和管理台 Cookie 不属于供应商凭据，禁止转发给上游。
    if (["x-lite-ccswitch-token", "cookie", "x-lite-handoff-session-key"].includes(lower) || lower.startsWith("x-lite-handoff-")) continue;
    // OAuth 文件模式由 Lite 独占这两个请求头，避免客户端旧会话污染当前账号。
    if (oauthFileHeaders && ["authorization", "chatgpt-account-id"].includes(lower)) continue;
    if (lower === "authorization" && !sessionHeaders.has(lower)) continue;
    if (sessionHeaders.has(lower)) {
      const selected = Array.isArray(value) ? value[0] : value;
      if (selected !== undefined && String(selected).trim()) {
        sessionValues[lower] = String(selected);
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(provider.customHeaders || {})) {
    if (value !== undefined && value !== null && String(value) !== "") {
      headers.set(key, String(value));
    }
  }

  for (const [key, value] of Object.entries(sessionValues)) {
    headers.set(key, value);
  }

  if (oauthFileHeaders) {
    for (const [key, value] of Object.entries(oauthFileHeaders)) {
      headers.set(key, value);
    }
    if (provider.upstreamMode === "codex_oauth") {
      headers.set("originator", "cc-switch");
    }
  } else if (provider.authMode === "api_key" && provider.apiKey) {
    headers.set("authorization", `Bearer ${provider.apiKey}`);
  }
  return headers;
}

export async function buildProviderOnlyHeaders(provider, clientSessionHeaders = null) {
  const headers = new Headers();
  const sessionHeaders = new Set(
    provider?.authMode === "client_session" ? provider.sessionHeaders || [] : [],
  );
  const oauthFileHeaders = isOAuthFileAuth(provider)
    ? await readOAuthFileHeaders(provider)
    : null;
  if (provider.authMode === "api_key" && provider.apiKey) {
    headers.set("authorization", `Bearer ${provider.apiKey}`);
  }
  for (const [key, value] of Object.entries(provider.customHeaders || {})) {
    if (value !== undefined && value !== null && String(value) !== "") {
      headers.set(key, String(value));
    }
  }
  if (clientSessionHeaders && provider?.authMode === "client_session") {
    for (const name of sessionHeaders) {
      const value = clientSessionHeaders[name];
      if (value) headers.set(name, String(value));
    }
  }
  if (oauthFileHeaders) {
    for (const [key, value] of Object.entries(oauthFileHeaders)) {
      headers.set(key, value);
    }
    if (provider.upstreamMode === "codex_oauth") {
      headers.set("originator", "cc-switch");
    }
  }
  return headers;
}

export function rectifyRequestBody(provider, body) {
  if (!body?.length) return body;
  let json;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }

  if (json && typeof json === "object" && !Array.isArray(json)) {
    if (json.model && provider.modelMap?.[json.model]) {
      json.model = provider.modelMap[json.model];
    }
    for (const key of provider.stripParams || []) {
      delete json[key];
    }
  }

  return Buffer.from(JSON.stringify(json));
}

export function normalizeProxyPath(pathname) {
  let next = parseProviderRoute(pathname).pathname;
  if (next.startsWith("/codex/")) {
    next = next.slice("/codex".length);
  }
  while (next.startsWith("/v1/v1/")) {
    next = next.slice(3);
  }
  if (next === "/models") return "/v1/models";
  if (next === "/responses" || next.startsWith("/responses/")) return `/v1${next}`;
  if (next === "/chat/completions") return "/v1/chat/completions";
  return next;
}

/**
 * 解析 Lite 入口中的供应商路径前缀。
 * 默认 /v1 路径属于 cct 池；仅保留 Plus 的显式固定入口。
 */
export function parseProviderRoute(pathname) {
  const value = String(pathname || "/");
  for (const [prefix, routeKey] of PROVIDER_ROUTE_PREFIXES) {
    if (value === prefix || value.startsWith(`${prefix}/`)) {
      return {
        routeKey,
        pathname: value.slice(prefix.length) || "/",
      };
    }
  }
  return { routeKey: "cct", pathname: value };
}

export function joinUpstreamUrl(baseUrl, pathname, search, provider = null) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    throw nonRetryableError("供应商 Base URL 为空", 400);
  }
  let nextPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (provider?.upstreamMode === "codex_oauth" && nextPath.startsWith("/v1/")) {
    nextPath = nextPath.slice(3);
  }
  if (base.endsWith("/v1") && nextPath.startsWith("/v1/")) {
    nextPath = nextPath.slice(3);
  }
  return `${base}${nextPath}${search || ""}`;
}

export function isProxyRoute(pathname) {
  const next = parseProviderRoute(pathname).pathname;
  if (next === "/models" || next === "/responses") return true;
  if (next === "/chat/completions") return true;
  if (next.startsWith("/responses/")) return true;
  if (next.startsWith("/v1/")) return true;
  if (next === "/v1") return true;
  if (next.startsWith("/codex/v1/")) return true;
  return false;
}

export function isStreamingRequest(req, pathname, body) {
  const accept = String(req.headers.accept || "").toLowerCase();
  if (accept.includes("text/event-stream")) return true;
  if (pathname.includes("stream")) return true;
  if (!body?.length) return false;
  try {
    const json = JSON.parse(body.toString("utf8"));
    return Boolean(json?.stream);
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}
