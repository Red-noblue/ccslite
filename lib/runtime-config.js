/**
 * Lite CC Switch 运行时配置。
 * 集中解析监听地址、数据路径和访问令牌，避免服务器入口重复处理环境变量。
 */

import path from "node:path";
import { readFileSync } from "node:fs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// 同一个解析器供直接启动和重启脚本使用。只读取赋值，不执行 shell 命令。
export function loadRuntimeEnvironment(dirname, env = process.env) {
  const envFile = path.resolve(env.LITE_CCSWITCH_ENV_FILE || path.join(env.LITE_CCSWITCH_DATA_DIR || path.join(dirname, "data"), "runtime.env"));
  let raw;
  try {
    raw = readFileSync(envFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && !env.LITE_CCSWITCH_ENV_FILE) return { ...env };
    throw error;
  }
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^\s*(LITE_CCSWITCH_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) throw new Error(`启动环境文件存在无效赋值：${envFile}`);
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return { ...values, ...env };
}

export function createRuntimeConfig({ dirname, env = loadRuntimeEnvironment(dirname) } = {}) {
  const dataDir = path.resolve(env.LITE_CCSWITCH_DATA_DIR || path.join(dirname, "data"));
  const listenHost = String(env.LITE_CCSWITCH_HOST || "127.0.0.1").trim();
  const listenPort = Number(env.LITE_CCSWITCH_PORT || "15720");
  const publicPort = Number(env.LITE_CCSWITCH_PUBLIC_PORT || listenPort);
  let handoffGroupPortMap = {};
  if (env.LITE_CCSWITCH_HANDOFF_GROUP_PORTS) {
    try {
      const parsed = JSON.parse(env.LITE_CCSWITCH_HANDOFF_GROUP_PORTS);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必须是对象");
      handoffGroupPortMap = Object.fromEntries(Object.entries(parsed).map(([id, port]) => [String(id), Number(port)]));
    } catch (error) {
      throw new Error(`LITE_CCSWITCH_HANDOFF_GROUP_PORTS 无效：${error.message}`);
    }
  }
  const proxyToken = String(env.LITE_CCSWITCH_PROXY_TOKEN || "");
  // 未单独设置管理令牌时复用代理令牌，避免公网部署只保护了代理接口。
  const adminToken = String(
    env.LITE_CCSWITCH_ADMIN_TOKEN || env.LITE_CCSWITCH_PROXY_TOKEN || "",
  );

  return {
    dataDir,
    publicDir: path.join(dirname, "public"),
    configPath: env.LITE_CCSWITCH_CONFIG || path.join(dataDir, "config.json"),
    usagePath: env.LITE_CCSWITCH_USAGE || path.join(dataDir, "usage.jsonl"),
    priceLabPath: env.LITE_CCSWITCH_PRICE_LAB || path.join(dataDir, "price-lab.json"),
    payloadDiagnosticsPath: env.LITE_CCSWITCH_413_LOG ||
      path.join(dataDir, "413-diagnostics.jsonl"),
    listenHost,
    listenPort,
    publicPort,
    publicHost: String(env.LITE_CCSWITCH_PUBLIC_HOST || listenHost),
    handoffWorker: env.LITE_CCSWITCH_HANDOFF_WORKER === "1",
    handoffReadOnly: env.LITE_CCSWITCH_HANDOFF_READ_ONLY === "1",
    handoffContinuation: env.LITE_CCSWITCH_HANDOFF_CONTINUATION === "1",
    handoffWorkerId: String(env.LITE_CCSWITCH_HANDOFF_WORKER_ID || ""),
    handoffGroupPortMap,
    proxyToken,
    adminToken,
    isLoopback: LOOPBACK_HOSTS.has(listenHost),
    shutdownGraceMs: nonNegativeInt(env.LITE_CCSWITCH_SHUTDOWN_GRACE_MS, 0),
    recoveryProbeIntervalMs: positiveInt(
      env.LITE_CCSWITCH_RECOVERY_PROBE_INTERVAL_MS,
      5_000,
    ),
  };
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}
