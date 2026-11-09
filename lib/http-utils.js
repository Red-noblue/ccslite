/**
 * HTTP 请求体、响应头、静态文件和访问令牌工具。
 * 集中处理协议层细节，让服务器入口专注路由与业务编排。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { nonRetryableError } from "./proxy-errors.js";

const MAX_BODY_BYTES = 200 * 1024 * 1024;

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function copyResponseHeaders(res, headers, mode) {
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "content-length") return;
    if (lower === "content-encoding") return;
    res.setHeader(key, value);
  });
  if (mode === "stream") {
    res.setHeader("cache-control", "no-cache");
    res.setHeader("x-accel-buffering", "no");
  }
}

export async function serveStatic(req, res, url, publicDir) {
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const absPath = path.join(publicDir, filePath);
  if (!absPath.startsWith(publicDir)) {
    sendText(res, 403, "禁止访问");
    return;
  }

  try {
    const info = await stat(absPath);
    if (!info.isFile()) {
      sendText(res, 404, "页面不存在");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", contentType(absPath));
    createReadStream(absPath).pipe(res);
  } catch {
    sendText(res, 404, "页面不存在");
  }
}

export async function readJsonBody(req) {
  const body = await readRawBody(req);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw nonRetryableError("请求体不是合法 JSON", 400);
  }
}

export async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw nonRetryableError("请求体过大", 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}

export function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(text);
}

export function assertProxyAccess(req, res, proxyToken) {
  if (!proxyToken) return true;
  if (req.headers["x-lite-ccswitch-token"] === proxyToken) return true;
  sendJson(res, 401, {
    error: {
      message: "代理访问令牌无效",
      type: "proxy_auth_failed",
    },
  });
  return false;
}

export function shouldSendBody(method = "GET") {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

export function parseUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
