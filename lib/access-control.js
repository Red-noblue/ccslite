/**
 * 本机和公网访问控制。
 * 公网接口必须认证，管理台使用签名的 HttpOnly 会话 Cookie 访问 API 和状态流。
 */

import crypto from "node:crypto";
import { readJsonBody, sendJson } from "./http-utils.js";

const COOKIE_NAME = "lite_admin_session";
const SESSION_SECONDS = 12 * 60 * 60;

export function createAccessControl({ isLoopback, proxyToken, adminToken }) {
  function equal(a, b) {
    const left = Buffer.from(String(a || ""));
    const right = Buffer.from(String(b || ""));
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  function signature(expiry) {
    return crypto.createHmac("sha256", adminToken).update(expiry).digest("hex");
  }

  function authenticated(req) {
    if (!adminToken) return isLoopback;
    if (equal(req.headers["x-lite-ccswitch-token"], adminToken)) return true;
    const cookie = String(req.headers.cookie || "").split(";")
      .map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
    const [expiry = "", signed = ""] = (cookie || "").slice(COOKIE_NAME.length + 1).split(".");
    return Number(expiry) > Date.now() && equal(signature(expiry), signed);
  }

  function assertAdmin(req, res) {
    if (authenticated(req)) return true;
    sendJson(res, adminToken ? 401 : 503, {
      error: {
        message: adminToken ? "请登录管理台" : "非本机监听必须配置管理令牌",
        type: adminToken ? "admin_auth_failed" : "admin_auth_not_configured",
      },
    });
    return false;
  }

  function assertProxy(req, res) {
    if (!proxyToken && isLoopback) return true;
    if (proxyToken && equal(req.headers["x-lite-ccswitch-token"], proxyToken)) return true;
    sendJson(res, proxyToken ? 401 : 503, {
      error: {
        message: proxyToken ? "代理访问令牌无效" : "非本机监听必须配置代理令牌",
        type: proxyToken ? "proxy_auth_failed" : "proxy_auth_not_configured",
      },
    });
    return false;
  }

  async function handleAuth(req, res, pathname) {
    if (req.method === "GET" && pathname === "/api/auth/status") {
      sendJson(res, 200, { required: Boolean(adminToken) || !isLoopback, authenticated: authenticated(req) });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/auth/login") {
      const { token } = await readJsonBody(req);
      if (!adminToken || !equal(token, adminToken)) {
        sendJson(res, 401, { error: { message: "管理令牌无效", type: "admin_auth_failed" } });
        return true;
      }
      const expiry = String(Date.now() + SESSION_SECONDS * 1000);
      const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
      res.setHeader("set-cookie", `${COOKIE_NAME}=${expiry}.${signature(expiry)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`);
      sendJson(res, 200, { authenticated: true });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/auth/logout") {
      res.setHeader("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      sendJson(res, 200, { authenticated: false });
      return true;
    }
    return false;
  }

  return { assertAdmin, assertProxy, handleAuth };
}
