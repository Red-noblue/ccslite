/**
 * OAuth 动态认证文件模块。
 *
 * Lite 仅保存认证文件路径；每次转发或连通性测试都会重新读取当前 Codex
 * OAuth 会话，并只在本次上游请求内使用，绝不把令牌写入配置、日志或接口响应。
 */

import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const AUTH_FILE_NAME = "auth.json";
const DEFAULT_CODEX_HOME_NAME = ".codex";
const CC_SWITCH_HOME_NAME = ".cc-switch";
const CC_SWITCH_MARKERS = [
  "codex_oauth_auth.json",
  "codex_managed_oauth_live_auth.json",
];

export function isOAuthFileAuth(provider) {
  return provider?.authMode === "oauth_file";
}

/**
 * 从配置的认证文件即时提取上游所需请求头。
 */
export async function readOAuthFileHeaders(provider, options) {
  return readOAuthFileHeadersFromPath(provider?.oauthFilePath, options);
}

export async function readOAuthFileHeadersFromPath(filePath, {
  homeDir = runtimeHomeDir(),
} = {}) {
  const normalizedHomeDir = path.resolve(homeDir);
  const resolvedHomeDir = await realpath(normalizedHomeDir).catch(() => normalizedHomeDir);
  const configuredPath = normalizeConfiguredPath(filePath, normalizedHomeDir);
  if (!configuredPath) {
    throw oauthFileError("未选择 OAuth 认证文件");
  }

  let resolvedPath;
  try {
    resolvedPath = await realpath(configuredPath);
  } catch {
    throw oauthFileError("OAuth 认证文件不存在或无法读取");
  }
  if (!isPathInside(resolvedPath, resolvedHomeDir) || path.basename(resolvedPath) !== AUTH_FILE_NAME) {
    throw oauthFileError("OAuth 认证文件必须是当前用户目录内的 auth.json");
  }

  let fileInfo;
  try {
    fileInfo = await stat(resolvedPath);
  } catch {
    throw oauthFileError("OAuth 认证文件无法读取");
  }
  if (!fileInfo.isFile()) {
    throw oauthFileError("OAuth 认证文件不是普通文件");
  }

  let payload;
  try {
    payload = JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch {
    // CC Switch 切换账号时可能正在原子替换文件；下次请求会重新读取，不保留失败结果。
    throw oauthFileError("OAuth 认证文件暂时不可用，请等待 CC Switch 完成账号切换后重试");
  }

  const accessToken = nonEmptyString(payload?.tokens?.access_token);
  const accountId = nonEmptyString(payload?.tokens?.account_id);
  if (!accessToken || !accountId) {
    throw oauthFileError("OAuth 认证文件缺少当前会话的访问令牌或账号标识");
  }

  return {
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
  };
}

/**
 * 仅扫描已知的本机 Codex/CC Switch 位置，返回文件元数据而非认证内容。
 */
export async function discoverOAuthFileCandidates({
  homeDir = runtimeHomeDir(),
  env = process.env,
} = {}) {
  const normalizedHomeDir = path.resolve(homeDir);
  const defaultCodexAuthPath = path.join(
    normalizedHomeDir,
    DEFAULT_CODEX_HOME_NAME,
    AUTH_FILE_NAME,
  );
  const ccSwitchHome = resolveOptionalHomePath(
    env.CC_SWITCH_HOME,
    normalizedHomeDir,
  ) || path.join(normalizedHomeDir, CC_SWITCH_HOME_NAME);
  const ccSwitchDetected = await hasAnyFile(
    CC_SWITCH_MARKERS.map((name) => path.join(ccSwitchHome, name)),
  );

  const paths = [defaultCodexAuthPath];
  const envCodexHome = resolveOptionalHomePath(env.CODEX_HOME, normalizedHomeDir);
  if (envCodexHome) paths.push(path.join(envCodexHome, AUTH_FILE_NAME));

  const seen = new Set();
  const candidates = [];
  for (const candidatePath of paths) {
    const normalizedPath = path.resolve(candidatePath);
    if (seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    candidates.push(await inspectCandidate(normalizedPath, {
      homeDir: normalizedHomeDir,
      isDefaultCodexAuth: normalizedPath === defaultCodexAuthPath,
      ccSwitchDetected,
    }));
  }

  return {
    ccSwitchDetected,
    candidates,
  };
}

async function inspectCandidate(candidatePath, {
  homeDir,
  isDefaultCodexAuth,
  ccSwitchDetected,
}) {
  const label = ccSwitchDetected && isDefaultCodexAuth
    ? "CC Switch 当前管理的 Codex 认证"
    : isDefaultCodexAuth
      ? "Codex 默认认证文件"
      : "当前环境的 Codex 认证文件";
  try {
    const resolvedPath = await realpath(candidatePath);
    const info = await stat(resolvedPath);
    if (!info.isFile()) {
      return unavailableCandidate(candidatePath, label, "不是普通文件");
    }
    await readOAuthFileHeadersFromPath(resolvedPath, { homeDir });
    return {
      path: candidatePath,
      label,
      detail: ccSwitchDetected && isDefaultCodexAuth
        ? "已识别到本机 CC Switch；后续请求会读取其当前同步的 Codex 会话。"
        : "后续请求会即时读取此文件。",
      status: "ready",
      modifiedAt: info.mtime.toISOString(),
    };
  } catch (error) {
    return unavailableCandidate(
      candidatePath,
      label,
      String(error?.message || "当前不可用"),
    );
  }
}

function unavailableCandidate(filePath, label, detail) {
  return {
    path: filePath,
    label,
    detail,
    status: "unavailable",
    modifiedAt: "",
  };
}

function normalizeConfiguredPath(value, homeDir) {
  const input = String(value || "").trim();
  if (!input) return "";
  const expanded = input === "~"
    ? homeDir
    : input.startsWith("~/")
      ? path.join(homeDir, input.slice(2))
      : input;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : "";
}

function resolveOptionalHomePath(value, homeDir) {
  const normalized = normalizeConfiguredPath(value, homeDir);
  return normalized && isPathInside(normalized, homeDir) ? normalized : "";
}

function isPathInside(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function hasAnyFile(paths) {
  for (const filePath of paths) {
    try {
      if ((await stat(filePath)).isFile()) return true;
    } catch {
      // 未找到候选位置并不属于异常。
    }
  }
  return false;
}

function nonEmptyString(value) {
  const text = String(value || "").trim();
  return text || "";
}

function runtimeHomeDir() {
  const configured = String(process.env.LITE_CCSWITCH_OAUTH_FILE_HOME || "").trim();
  return configured && path.isAbsolute(configured) ? configured : os.homedir();
}

function oauthFileError(message) {
  const error = new Error(message);
  // 认证源短暂不可用时允许自动路由尝试下一个供应商，但不污染该供应商熔断状态。
  error.status = 503;
  error.retryable = true;
  error.affectsCircuit = false;
  error.failureClass = "oauth_file_unavailable";
  return error;
}
