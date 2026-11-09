/**
 * 轻量版 CC Switch 服务器入口。
 *
 * 目标：在无桌面环境的服务器上提供 OpenAI/Codex 兼容本地代理、故障转移、
 * 熔断器和中文网页管理界面。实现参考 cc-switch 的队列路由、熔断和流式
 * 首包探测策略，但移除 Tauri 托盘、桌面接管和本机配置改写能力。
 */

import { createRoutingRecovery } from "./lib/routing-recovery.js";
import { createUsageQueries } from "./lib/usage-queries.js";
import { createConfigTransactions } from "./lib/config-transactions.js";
import { createResponseContextSync } from "./lib/response-context-sync.js";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { requestHandoff } from "./lib/handoff-rpc.js";
import { availableParallelism } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { CircuitBreaker } from "./lib/circuit-breaker.js";
import { createClientSessionContextStore } from "./lib/client-session-context.js";
import { createConnectivityScheduler } from "./lib/connectivity-scheduler.js";
import { discoverOAuthFileCandidates } from "./lib/oauth-file-source.js";
import {
  copyResponseHeaders,
  parseUrl,
  readJsonBody,
  readRawBody,
  sendJson,
  serveStatic,
  shouldSendBody,
} from "./lib/http-utils.js";
import {
  applyManualModelSupport,
  getModelAvailability,
  normalizeConnectivityCandidateModels,
  normalizeConnectivityInterval,
  normalizeModelSupport,
  orderProvidersForModel,
  providerRetryDelay,
  preferredProviderRetryDelay,
  rememberProviderModelEvidence,
  uniqueStrings,
} from "./lib/model-support.js";
import {
  calculateActualCost,
  calculateUsageCost,
  fitEffectivePrices,
  normalizeRawUsage,
} from "./lib/price-calculation.js";
import { createPriceLabService } from "./lib/price-lab-service.js";
import { createExchangeRateService } from "./lib/exchange-rate.js";
import {
  classifyProxyFailure,
  detectKnownProviderCompatibilityError,
  detectKnownProviderPayloadLimitError,
  detectKnownResponseContextError,
  detectUpstreamPayloadError,
  formatFetchError,
  isCapacityText,
  isRetryableStatus,
  isUnsupportedModelText,
  nonRetryableError,
  retryableError,
  upstreamError,
} from "./lib/proxy-errors.js";
import {
  compareProviders,
  createProvider as createProviderConfig,
  isProviderInAutoRouting,
  sanitizeProvider,
  setProviderRoutingEnabled,
  sortProviders as sortProviderList,
  updateProvider as updateProviderConfig,
} from "./lib/provider-config.js";
import { isHigherPriority } from "./lib/provider-order.js";
import { createShutdownController } from "./lib/shutdown-controller.js";
import { createPayloadDiagnostics } from "./lib/payload-diagnostics.js";
import {
  buildInterleavedAttemptPlan,
} from "./lib/retry-scheduler.js";
import { createRecoveryProbeManager } from "./lib/recovery-probes.js";
import { readUpstreamErrorBody } from "./lib/upstream-error-body.js";
import {
  createStickyRoutingStore,
  extractResponseIds,
  extractRoutingContext,
  shouldInvalidateSticky,
} from "./lib/sticky-routing.js";
import {
  attachStreamDiagnostics,
  buildSseDiagnostics,
  createSseInspector,
  pipeSseReadableStream,
  probeSseStream,
  readFirstChunk,
} from "./lib/sse-stream.js";
import { DEFAULT_STREAM_POLICY, normalizeStreamPolicy } from "./lib/stream-policy.js";
import {
  appendProviderAttempt,
  detectFastBillingMode,
  extractRequestModel,
  extractUsage,
  isProviderTestUsageRecord,
  normalizeBillingModel,
  normalizeProviderAttempts,
  normalizeProviderTestUsageRecord,
  normalizeUsageRecord as normalizeStoredUsageRecord,
} from "./lib/usage-records.js";
import { createRuntimeConfig } from "./lib/runtime-config.js";
import { readBuildInfo } from "./lib/build-info.js";
import { createProviderActivity } from "./lib/provider-activity.js";
import { createRequestLifecycleRegistry } from "./lib/request-lifecycle.js";
import { createGroupStatistics, usageGroupId } from "./lib/group-usage.js";
import { createGroupListeners } from "./lib/group-listeners.js";
import { providersForGroup, groupProxy, connectivityTargets } from "./lib/group-routing.js";
import { applyGlobalPalette, assignGroupColorIndexes } from "./lib/ui-theme.js";
import { createAccessControl } from "./lib/access-control.js";
import { createConfigStore } from "./lib/config-store.js";
import {
  cloneGroup,
  createGroup,
  normalizeGroups,
  normalizeTheme,
  normalizeUiPalette,
  sanitizeGroup,
} from "./lib/group-config.js";
import { loadUsageRecords as readUsageRecords, loadUsageRecordsFromOffset, appendUsageRecord, usageFileMetadata } from "./lib/usage-store.js";
import { decodeHandoffResponseContext, responseContextScope } from "./lib/handoff-session.js";
import {
  buildProviderOnlyHeaders,
  buildUpstreamHeaders,
  isProxyRoute,
  isStreamingRequest,
  joinUpstreamUrl,
  normalizeProxyPath,
  parseProviderRoute,
  rectifyRequestBody,
} from "./lib/upstream-request.js";
import { getProviderDispatcher } from "./lib/upstream-proxy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUILD_INFO = readBuildInfo(__dirname);
const runtime = createRuntimeConfig({ dirname: __dirname });
const {
  dataDir: DATA_DIR,
  publicDir: PUBLIC_DIR,
  configPath: CONFIG_PATH,
  usagePath: USAGE_PATH,
  priceLabPath: PRICE_LAB_PATH,
  payloadDiagnosticsPath: PAYLOAD_DIAGNOSTICS_PATH,
  listenHost: LISTEN_HOST,
  listenPort: LISTEN_PORT,
  publicPort: PUBLIC_LISTEN_PORT,
  publicHost: PUBLIC_LISTEN_HOST,
  handoffWorker: HANDOFF_WORKER,
  handoffReadOnly: initialHandoffReadOnly,
  handoffContinuation: initialHandoffContinuation,
  handoffWorkerId: HANDOFF_WORKER_ID,
  handoffGroupPortMap: HANDOFF_GROUP_PORT_MAP,
  proxyToken: PROXY_TOKEN,
  adminToken: ADMIN_TOKEN,
  isLoopback: IS_LOOPBACK,
} = runtime;
let handoffReadOnly = initialHandoffReadOnly;
let handoffContinuation = initialHandoffContinuation;
const accessControl = createAccessControl(runtime);
const configStore = createConfigStore(CONFIG_PATH);
function assertHandoffWritable() {
  if (!handoffReadOnly) return;
  throw Object.assign(new Error("当前版本处于只读预热阶段，尚未取得写入租约"), { status: 503, code: "handoff_read_only" });
}

function assertHandoffConfigWritable() {
  assertHandoffWritable();
  if (handoffContinuation) {
    throw Object.assign(new Error("旧交接版本只允许完成已有请求，不能修改共享配置"), { status: 409, code: "handoff_continuation_read_only" });
  }
}

function actualGroupPort(group) {
  return HANDOFF_WORKER ? Number(HANDOFF_GROUP_PORT_MAP[group.id] || 0) : Number(group.listener?.port);
}

// 每次服务启动生成新标识，供前端识别优雅重启后的状态版本重新计数。
const SERVER_INSTANCE_ID = crypto.randomUUID();
// 默认优雅关闭不设置强制截止时间，避免长时间 Responses/SSE 对话被 120 秒上限切断。
// 需要自动强制退出时，再通过 LITE_CCSWITCH_SHUTDOWN_GRACE_MS 显式配置毫秒数。
const SHUTDOWN_GRACE_MS = runtime.shutdownGraceMs;
const GPT_55_BILLING_MODEL = "gpt-5.5";
const FAST_MODE_MULTIPLIER = 2.5;
const PROVIDER_TEST_MODEL = "gpt-6.1-sol";
const PROVIDER_TEST_MODELS = ["gpt-6.1-sol", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5"];
const PROVIDER_TEST_EXPECTED_TEXT = "CCOK";
const PROVIDER_TEST_TIMEOUT_MS = 45_000;
const CPU_PARALLELISM = Math.max(1, availableParallelism());
// 正式环境固定为 5 秒；测试进程可缩短间隔以验证两次连续恢复确认。
const RECOVERY_PROBE_INTERVAL_MS = runtime.recoveryProbeIntervalMs;
const DEFAULT_GPT_55_PRICING = {
  inputPerMillion: 5,
  outputPerMillion: 30,
  cacheReadPerMillion: 0.5,
  cacheCreationPerMillion: 0,
};

const defaultConfig = {
  version: 2,
  proxy: {
    autoFailoverEnabled: true,
    currentProviderId: null,
    maxAttempts: 30,
    preferredProviderMaxAttempts: 6,
    providerMaxAttempts: 2,
    retryScheduleChunkSize: 2,
    maxRetryElapsedMs: 300_000,
    providerRetryDelayMs: 2_000,
    providerRetryMaxDelayMs: 5_000,
    providerRetryBudgetMs: 20_000,
    preferredProviderRetryDelayMs: 2_000,
    preferredProviderRetryMaxDelayMs: 5_000,
    preferredProviderRetryBudgetMs: 20_000,
    streamingFirstByteTimeoutMs: 60_000,
    streamingIdleTimeoutMs: 120_000,
    ...DEFAULT_STREAM_POLICY,
    nonStreamingTimeoutMs: 600_000,
    circuit: {
      failureThreshold: 4,
      successThreshold: 2,
      openTimeoutMs: 60_000,
      errorRateThreshold: 0.6,
      minRequests: 10,
    },
  },
  providers: [],
  groups: [],
  ui: {
    groupThemeEnabled: true,
    palette: "ocean",
  },
  billing: {
    currency: "USD",
    pricing: {
      [GPT_55_BILLING_MODEL]: DEFAULT_GPT_55_PRICING,
    },
  },
  connectivityTest: {
    candidateModels: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    periodicIntervalMs: 10_800_000,
  },
};

const metrics = {
  startedAt: new Date().toISOString(),
  activeConnections: 0,
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  failoverCount: 0,
  lastRequestAt: null,
  lastError: null,
  currentProviderId: null,
  currentProviderName: null,
  currentProviderUpdatedAt: null,
  currentProviderSource: null,
  statusRevision: 0,
  lastRequestId: null,
};

let config = structuredClone(defaultConfig);
let committedConfigRevision = null;
const configTransactions = createConfigTransactions({
  read: () => config,
  persist: (draft, options) => saveConfig(draft, options),
  readAuthority: async () => {
    const result = HANDOFF_WORKER ? await requestHandoff("handoff_read_config", {}) : { config: await configStore.load() };
    committedConfigRevision = result.revision ?? null;
    return { ...result, config: normalizeConfig(result.config) };
  },
  publish: (draft) => {
    config = draft;
    usageQueries.invalidate();
    for (const breaker of breakers.values()) breaker.updateConfig(config.proxy.circuit);
    syncAllProviderRecoveryProbes();
  },
});
function commitConfig(change) {
  if (handoffContinuation) return Promise.resolve(false);
  assertHandoffConfigWritable();
  return configTransactions.commit(change);
}
async function commitProviderEvidence(providerId, model, state, source, reason) {
  return commitConfig((draft) => {
    const provider = draft.providers.find((item) => item.id === providerId);
    return provider ? rememberProviderModelEvidence(provider, model, state, source, reason) : false;
  });
}
const providerActivity = createProviderActivity({ onChange: publishRuntimeStatusUpdate });
const requestLifecycle = createRequestLifecycleRegistry({ onChange: publishRuntimeStatusUpdate });
const groupStatistics = createGroupStatistics();
const breakers = new Map();
// 正常请求保留会话粘滞；低价供应商确认恢复后，再定向迁移较贵供应商的粘滞。
const groupStickyStores = new Map();
function getGroupStickyRouting(groupId = "default") {
  if (!groupStickyStores.has(groupId)) groupStickyStores.set(groupId, createStickyRoutingStore());
  return groupStickyStores.get(groupId);
}
let groupListeners = null;
// 记录本进程内“同模型连续业务或探测成功”的供应商。它不是供应商实体或计费类别，
// 只用于让恢复事件早于下一次业务成功时，仍能在后续请求中兑现价格优先策略。
const { reconcileCompletedStickyProvider, markConfirmedRecovery, clearConfirmedRecovery, isRecoveryConfirmed, migrateStickyToRecoveredProvider } = createRoutingRecovery({
  getConfig: () => config, getStores: () => groupStickyStores, getRecoveryProbeManager: () => recoveryProbeManager,
  selectProviders, isProviderInAutoRouting, enqueueMigratedResponse,
});
// 覆盖从读取请求体到写完响应的完整生命周期，包含尚未收到上游首包的请求。
const activeRequests = new Set();
const activeStreamingResponses = new Set();
const activeClientSockets = new Set();
// 管理台状态流不属于业务请求；关闭时主动结束，避免阻塞优雅重启。
const statusSubscribers = new Set();
let isShuttingDown = false;
let shutdownController = null;
const usageState = {
  loaded: false,
  records: [],
  maxRecords: 5000,
  malformedCount: 0,
  lastWriteAt: null,
  lastWriteError: null,
  failedWrites: 0,
  fileSignature: null,
  fileInode: null,
  fileOffset: 0,
  fileRemainder: "",
  recordKeys: new Set(),
  lastReadError: null,
};
const usageQueries = createUsageQueries({
  getRecords: () => usageState.records,
  normalizeUsageRecord,
  getPricing: () => sanitizeBillingConfig(config.billing),
});
let usageWriteQueue = Promise.resolve();
// 监督器意外退出时，工作进程不能直接写共享 usage.jsonl；先写入本工作进程
// 独有的暂存文件，下一次监督器取得租约后再合并，避免已完成请求丢失。
let handoffPendingUsageQueue = Promise.resolve();
let adminMutationQueue = Promise.resolve();
let handoffControlGeneration = 0;
const pendingSessionCheckpoints = new Map();
let responseContextFlushQueue = Promise.resolve();
const responseContextSync = createResponseContextSync({
  send: (changes) => requestHandoff("handoff_response_contexts", { changes }),
  acceptContext: (change, context) => {
    const [groupId] = JSON.parse(change.scope);
    groupStickyStores.get(groupId)?.acceptResponseContext(change.responseId, change.model, change.providerId, context);
  },
  retryConflict: (change, context) => {
    const [groupId] = JSON.parse(change.scope);
    const providers = providersForGroup(config, groupId);
    const target = providers.find((item) => item.id === change.providerId);
    const current = providers.find((item) => item.id === context?.providerId);
    return target && current && isProviderInAutoRouting(target) && isHigherPriority(target, current) && isRecoveryConfirmed(target, change.model)
      ? { ...change, expectedProviderId: context.providerId, expectedFallbackProviderIds: context.fallbackProviderIds,
        fallbackProviderIds: [...new Set([context.providerId, ...context.fallbackProviderIds, ...change.fallbackProviderIds])].filter((id) => id !== target.id) }
      : null;
  },
});
function enqueueMigratedResponse(groupId, change) {
  if (HANDOFF_WORKER) responseContextSync.enqueue({ ...change, scope: responseContextScope(groupId, "cct", change.model) });
}
function flushResponseContexts() {
  const task = responseContextFlushQueue.catch(() => {}).then(async () => {
    await responseContextSync.flush();
    for (const [id, checkpoint] of pendingSessionCheckpoints) {
      const accepted = await requestHandoff("handoff_session_checkpoint", checkpoint);
      if (accepted === false) throw new Error("前置器拒绝了会话完成检查点，保留待确认状态");
      if (pendingSessionCheckpoints.get(id) === checkpoint) pendingSessionCheckpoints.delete(id);
    }
  });
  responseContextFlushQueue = task;
  return task;
}


let usageRefreshQueue = Promise.resolve();
const priceLabs = new Map();
const exchangeRates = createExchangeRateService({ filePath: path.join(DATA_DIR, "exchange-rate.json") });
function getGroupPriceLab(groupId) {
  if (!priceLabs.has(groupId)) {
    priceLabs.set(groupId, createPriceLabService({
      filePath: groupId === "default" ? PRICE_LAB_PATH : path.join(DATA_DIR, "group-price-lab", `${encodeURIComponent(groupId)}.json`),
      findProvider: (providerId) => findProvider(providerId),
      getUsageRecords: () => usageState.records.filter((record) => usageGroupId(record) === groupId),
      normalizeUsageRecord: (record) => normalizeUsageRecord(record),
      extractTextFromPayload: (payload) => extractTextFromPayload(payload),
      startProviderActivity: (provider) => providerActivity.start(provider, "price_experiment", groupId),
      getExchangeRate: async () => {
        // 汇率缓存不可用时仍允许保存原币账单，禁止为录入扣费发起联网等待。
        const current = await exchangeRates.read().catch(() => null);
        return current?.rate ? { ...current.rate, stale: current.stale } : null;
      },
    }));
  }
  return priceLabs.get(groupId);
}
const resourceSampler = {
  lastCpuUsage: process.cpuUsage(),
  lastHrtimeNs: process.hrtime.bigint(),
  lastCpuPercent: 0,
  lastCpuSampleWindowSeconds: 0,
  lastSampledAtMs: 0,
  cachedPayload: null,
};
let connectivityScheduler = null;
let recoveryProbeManager = null;
const recoveryProbeGroups = new Map();
const clientSessionContexts = createClientSessionContextStore();
const payloadDiagnostics = createPayloadDiagnostics({
  logPath: PAYLOAD_DIAGNOSTICS_PATH,
  runDiagnostic: run413Diagnostic,
  persist: HANDOFF_WORKER
    ? (record) => requestHandoff("handoff_persist_diagnostic", {
      workerId: HANDOFF_WORKER_ID || `${BUILD_INFO.releaseId}:${process.pid}`,
      record,
    })
    : null,
});

if (process.env.LITE_CCSWITCH_SKIP_BOOTSTRAP !== "1") {
  await bootstrap();
}

async function bootstrap() {
  await mkdir(DATA_DIR, { recursive: true });
  config = await loadConfig();
  await loadUsageRecords();
  restoreRuntimeMetrics();
  if (!IS_LOOPBACK) {
    if (!PROXY_TOKEN) {
      console.warn("当前监听地址不是本机回环地址，未设置 LITE_CCSWITCH_PROXY_TOKEN，代理接口将拒绝访问。");
    }
    if (!ADMIN_TOKEN) {
      console.warn("当前监听地址不是本机回环地址，未设置 LITE_CCSWITCH_ADMIN_TOKEN，管理接口将拒绝访问。");
    }
  }
  await getGroupPriceLab("default").load();
  const server = http.createServer((req, res) => routeRequest(req, res));
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  const trackSocket = (socket) => {
    activeClientSockets.add(socket);
    socket.once("close", () => activeClientSockets.delete(socket));
  };
  server.on("connection", trackSocket);
  groupListeners = createGroupListeners({
    mainServer: server, mainPort: LISTEN_PORT,
    resolvePort: actualGroupPort,
    resolveHost: HANDOFF_WORKER ? () => "127.0.0.1" : undefined,
    allowEphemeralPort: HANDOFF_WORKER,
    handleRequest: routeRequest,
    onConnection: trackSocket,
    onChange: publishRuntimeStatusUpdate,
  });

  const shutdown = createShutdownController({
    server: groupListeners,
    activeRequests,
    activeStreamingResponses,
    activeClientSockets,
    graceMs: SHUTDOWN_GRACE_MS,
    onDraining: () => {
      isShuttingDown = true;
      closeStatusSubscribers();
      connectivityScheduler?.stop();
      recoveryProbeManager?.stop();
    },
    beforeExit: flushBackgroundWrites,
  });
  shutdownController = shutdown;

  process.on("SIGTERM", () => shutdown.requestShutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown.requestShutdown("SIGINT"));
  if (typeof process.send === "function") {
    // 监督器异常退出只触发首次优雅排空，不能把 IPC 断开当作第二次强制停止信号。
    process.once("disconnect", () => {
      if (shutdown.state() === "running") shutdown.requestShutdown("监督器连接断开");
    });
    if (!process.connected && shutdown.state() === "running") shutdown.requestShutdown("监督器连接已断开");
    process.on("message", (message) => {
      if (!HANDOFF_WORKER) return;
      const reply = (value) => {
        if (process.connected) process.send({ requestId: message.requestId, instanceId: SERVER_INSTANCE_ID, pid: process.pid, ...value }, () => {});
      };
      if (message?.type === "handoff_prepare_readonly") {
        prepareHandoffReadOnly(++handoffControlGeneration).then(() => reply({ type: "handoff_readonly" }))
          .catch((error) => reply({ type: "handoff_activation_failed", message: error.message }));
      } else if (message?.type === "handoff_prepare_continuation") {
        prepareHandoffContinuation(++handoffControlGeneration).then(() => reply({ type: "handoff_continuation" }))
          .catch((error) => reply({ type: "handoff_activation_failed", message: error.message }));
      } else if (message?.type === "handoff_activate") {
        ++handoffControlGeneration;
        activateHandoffWorker().then(() => reply({ type: "handoff_activated" }))
          .catch((error) => reply({ type: "handoff_activation_failed", message: error.message }));
      }
    });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(LISTEN_PORT, LISTEN_HOST, () => { server.off("error", reject); resolve(); });
  });
  for (const group of config.groups) {
    try { await groupListeners.apply(group); }
    catch (error) { console.error(`${group.name}：${error.message}`); }
  }
  console.log(`lite-ccswitch 代理服务已启动: http://${LISTEN_HOST}:${LISTEN_PORT}`);
  if (LISTEN_HOST === "0.0.0.0") {
    console.log(`局域网访问地址示例: http://<本机局域网IP>:${LISTEN_PORT}`);
  }
  await startBackgroundSchedulers();
}

async function flushBackgroundWrites() {
  while (connectivityScheduler?.isRunning() || recoveryProbeManager?.status().some((probe) => probe.running)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await payloadDiagnostics.flush();
  await usageWriteQueue;
  await handoffPendingUsageQueue;
  await configTransactions.flush();
  if (HANDOFF_WORKER) await flushResponseContexts();
}

async function prepareHandoffReadOnly(generation) {
  connectivityScheduler?.stop();
  recoveryProbeManager?.stop();
  await adminMutationQueue.catch(() => {});
  // 已返回响应的请求仍可能在落盘；后台探测也必须先完成，才能撤销写入权。
  while (activeRequests.size || connectivityScheduler?.isRunning() || recoveryProbeManager?.status().some((probe) => probe.running)) {
    if (generation !== handoffControlGeneration) throw new Error("只读准备已被后续激活取消");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await flushBackgroundWrites();
  if (generation !== handoffControlGeneration) throw new Error("只读准备已被后续激活取消");
  handoffReadOnly = true;
}

async function prepareHandoffContinuation(generation) {
  connectivityScheduler?.stop();
  recoveryProbeManager?.stop();
  await adminMutationQueue.catch(() => {});
  await configTransactions.flush();
  if (generation !== handoffControlGeneration) throw new Error("继续服务准备已被后续激活取消");
  if (HANDOFF_WORKER) await flushResponseContexts();
  await configTransactions.flush();
  if (generation !== handoffControlGeneration) throw new Error("继续服务准备已被后续激活取消");
  // 继续版本保留已有请求的业务能力；配置、后台探测和主动管理写入由前置器隔离。
  handoffContinuation = true;
}

async function activateHandoffWorker() {
  // 候选预热和旧版本观察期间，磁盘数据可能更新；激活前重新读取，避免旧快照覆盖配置。
  config = await loadConfig();
  if (HANDOFF_WORKER) {
    for (const group of config.groups) {
      await groupListeners.apply(group);
      if (!group.listener.enabled) delete HANDOFF_GROUP_PORT_MAP[group.id];
    }
  }
  await refreshUsageRecords();
  restoreRuntimeMetrics();
  priceLabs.clear();
  connectivityScheduler = null;
  recoveryProbeManager = null;
  handoffReadOnly = false;
  handoffContinuation = false;
  await startBackgroundSchedulers();
}

async function startBackgroundSchedulers() {
  if (connectivityScheduler || handoffReadOnly) {
    if (handoffReadOnly) console.log("当前版本处于只读预热阶段，暂停主动供应商探测和恢复探测。");
    return;
  }
  connectivityScheduler = createConnectivityScheduler({
    getIntervalMs: () => config.connectivityTest?.periodicIntervalMs,
    runTests: runConnectivityTestCycle,
    log: (message) => console.error(message),
  });
  recoveryProbeManager = createRecoveryProbeManager({
    intervalMs: RECOVERY_PROBE_INTERVAL_MS,
    requiredSuccesses: 2,
    getModel: (provider) => getRecoveryProbeModel(findProvider(provider.id) || provider),
    shouldProbe: (provider) => config.providers.some((item) => item.id === provider.id) && providerIsAutoRoutedAnywhere(provider),
    testProvider: (provider, model) => testProvider(
      findProvider(provider.id) || provider,
      [model],
      { persist: false, probeSource: "recovery", groupId: recoveryProbeGroups.get(provider.id) || "default" },
    ),
    onFailed: (provider, result) => clearConfirmedRecovery(provider, result?.model),
    onRecovered: async (provider, result) => {
      getBreaker(provider).recordProbeSuccess();
      markConfirmedRecovery(provider, result?.model);
      // 业务成功沿用业务路径保存模型证据，避免提前重复落盘打乱用量记录顺序。
      // 恢复探测需在此刷新证据，否则临时不支持缓存仍会阻止回迁。
      if (result?.source !== "business") await commitProviderEvidence(provider.id, result?.model,
        "supported", "provider_test", "recovery_probe_succeeded");
      migrateStickyToRecoveredProvider(provider, result?.model);
      if (HANDOFF_WORKER) await flushResponseContexts();
      publishRuntimeStatusUpdate();
    },
    log: (message) => console.error(message),
  });
  connectivityScheduler.start();
}

async function routeRequest(req, res, groupId = "default", listenHost = LISTEN_HOST) {
  const requestAccess = groupId === "default" ? accessControl : createAccessControl({
    isLoopback: ["127.0.0.1", "localhost", "::1"].includes(listenHost),
    proxyToken: PROXY_TOKEN, adminToken: ADMIN_TOKEN,
  });
  const url = parseUrl(req);
  const isStatusStream = url.pathname === "/api/status/events";
  const requestId = normalizeRequestId(req.headers["x-request-id"]) || crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-lite-ccswitch-instance-id", SERVER_INSTANCE_ID);
  res.setHeader("x-lite-ccswitch-group-id", groupId);
  try {
    if (isShuttingDown) {
      sendJson(res, 503, {
        error: {
          message: "Lite CC Switch 正在关闭，暂不接收新请求。",
          type: "service_shutting_down",
        },
      });
      return;
    }

    if (handoffReadOnly && (isProxyRoute(url.pathname) || !["GET", "HEAD"].includes(req.method))) {
      sendJson(res, 503, {
        error: { message: "候选版本仍在只读预热，暂不接收业务请求。", type: "handoff_read_only" },
      });
      return;
    }

    if (!isStatusStream) {
      activeRequests.add(res);
      // 客户端响应关闭后仍可能在落盘；由 finally 释放，关闭流程才会等待写入完成。
    }

    if (groupId !== "default" && !isProxyRoute(url.pathname)) {
      sendJson(res, 404, { error: { message: "此端口仅提供分组代理，请通过主服务端口管理分组。", type: "group_proxy_only" } });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      res.setHeader("cache-control", "no-store");
      if (await accessControl.handleAuth(req, res, url.pathname)) return;
      if (!accessControl.assertAdmin(req, res)) return;
      if (HANDOFF_WORKER && !["GET", "HEAD"].includes(req.method)) {
        // 同一工作进程内的管理写入也需串行，分组失败恢复不能覆盖同时提交的设置。
        const change = adminMutationQueue.catch(() => {}).then(() => handleAdminApi(req, res, url));
        adminMutationQueue = change; await change;
      } else await handleAdminApi(req, res, url);
      return;
    }

    if (isProxyRoute(url.pathname)) {
      if (!requestAccess.assertProxy(req, res)) {
        return;
      }
      await handleProxyRequest(req, res, url, requestId, groupId);
      return;
    }

    await serveStatic(req, res, url, PUBLIC_DIR);
  } catch (error) {
    console.error("请求处理失败:", error);
    if (!res.headersSent) {
      const statusCode = Number(error?.status || 500);
      sendJson(res, statusCode >= 400 && statusCode <= 599 ? statusCode : 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: statusCode >= 400 && statusCode < 500 ? "invalid_request" : "internal_error",
        },
      });
    } else {
      res.destroy(error);
    }
  } finally {
    if (!isStatusStream) {
      activeRequests.delete(res);
      shutdownController?.requestFinished();
    }
  }
}

async function handleAdminApi(req, res, url) {
  const method = req.method || "GET";
  const parts = url.pathname.split("/").filter(Boolean);
  const groupId = url.searchParams.get("groupId") || "default";
  if (!config.groups.some((group) => group.id === groupId)) throw nonRetryableError("分组不存在", 404);
  const priceLab = getGroupPriceLab(groupId);
  if (method === "GET" && (url.pathname.startsWith("/api/status") || url.pathname.startsWith("/api/billing/"))) {
    await refreshUsageRecords();
  }

  if (method === "GET" && url.pathname === "/api/status/events") {
    openStatusStream(res);
    return;
  }

  if (method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, buildStatusPayload());
    return;
  }

  if (method === "GET" && url.pathname === "/api/requests/active") {
    sendJson(res, 200, requestLifecycle.stats({
      groupId: url.searchParams.get("groupId") || null,
      idleTimeoutMs: groupProxy(config, groupId).streamingIdleTimeoutMs,
    }));
    return;
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "requests" && parts[2] && parts[3] === "cancel") {
    const request = requestLifecycle.get(decodeURIComponent(parts[2]));
    if (!request || (url.searchParams.get("groupId") && request.groupId !== groupId)) {
      sendJson(res, 404, { error: { message: "活动请求不存在", type: "not_found" } });
      return;
    }
    const cancelled = requestLifecycle.cancel(request.id, "operator_cancelled");
    sendJson(res, 200, { ok: Boolean(cancelled), request: requestLifecycle.get(request.id) || cancelled });
    return;
  }

  if (method === "GET" && url.pathname === "/api/diagnostics/413") {
    sendJson(res, 200, payloadDiagnostics.status());
    return;
  }

  if (method === "POST" && url.pathname === "/api/diagnostics/413/arm") {
    if (!payloadDiagnostics.arm()) {
      sendJson(res, 409, {
        error: { message: "已有 413 诊断正在等待或运行，请等待完成", type: "diagnostic_in_progress" },
      });
      return;
    }
    sendJson(res, 200, payloadDiagnostics.status());
    return;
  }

  if (method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, { ...sanitizeConfig(config, groupId), configCommit: { ...configTransactions.state(), revision: committedConfigRevision } });
    return;
  }

  if (method === "GET" && url.pathname === "/api/groups") {
    sendJson(res, 200, config.groups.map(buildGroupStatus));
    return;
  }

  if (method === "POST" && url.pathname === "/api/groups") {
    const payload = await readJsonBody(req);
    const sourceGroup = payload?.sourceGroupId
      ? config.groups.find((group) => group.id === String(payload.sourceGroupId))
      : null;
    if (payload?.sourceGroupId && !sourceGroup) {
      sendJson(res, 404, { error: { message: "源分组不存在", type: "not_found" } });
      return;
    }
    const group = sourceGroup
      ? cloneGroup(sourceGroup, {
        providers: config.providers,
        port: allocateGroupPort(),
      })
      : createGroup(payload, { providers: config.providers, listenPort: allocateGroupPort() });
    if (payload?.name !== undefined) {
      group.name = String(payload.name || "未命名分组").trim() || "未命名分组";
    }
    if (payload?.description !== undefined) {
      group.description = String(payload.description || "").trim();
    }
    if (payload?.listener && typeof payload.listener === "object") {
      updateGroup(group, { listener: payload.listener });
    }
    if (config.groups.some((item) => item.id === group.id)) throw nonRetryableError("分组标识已存在", 409);
    await mutateGroup(group, !Number(payload?.listener?.port), async () => {
      await commitConfig(async (draft) => {
        await activateNewGroup(group, !Number(payload?.listener?.port));
        draft.groups.push(group);
        assignGroupColorIndexes(draft.groups);
      });
    });
    sendJson(res, 201, buildGroupStatus(group));
    return;
  }

  if (parts[0] === "api" && parts[1] === "groups" && parts[2]) {
    const groupId = decodeURIComponent(parts[2]);
    const group = config.groups.find((item) => item.id === groupId);
    if (!group) {
      sendJson(res, 404, { error: { message: "分组不存在", type: "not_found" } });
      return;
    }
    if (method === "GET" && parts.length === 3) {
      sendJson(res, 200, buildGroupStatus(group));
      return;
    }
    if (method === "PUT" && parts.length === 3) {
      const payload = await readJsonBody(req);
      const updated = structuredClone(group);
      updateGroup(updated, payload);
      await mutateGroup(updated, false, async () => {
        await commitConfig(async (draft) => {
          await groupListeners.apply(updated);
          Object.assign(draft.groups.find((item) => item.id === groupId), updated);
        });
      });
      sendJson(res, 200, buildGroupStatus(config.groups.find((item) => item.id === groupId)));
      return;
    }
    if (method === "POST" && parts[3] === "clone") {
      const copy = cloneGroup(group, {
        providers: config.providers,
        port: allocateGroupPort(),
      });
      await mutateGroup(copy, true, async () => {
        await commitConfig(async (draft) => {
          await activateNewGroup(copy, true);
          draft.groups.push(copy);
          assignGroupColorIndexes(draft.groups);
        });
      });
      sendJson(res, 201, buildGroupStatus(copy));
      return;
    }
  }

  if (method === "GET" && url.pathname === "/api/billing/summary") {
    sendJson(res, 200, await buildBillingSummary({
      startAt: url.searchParams.get("startAt"),
      endAt: url.searchParams.get("endAt"),
      providerId: url.searchParams.get("providerId"),
      groupId: url.searchParams.get("groupId"),
      timezoneOffset: url.searchParams.get("timezoneOffset"),
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/api/billing/logs") {
    sendJson(res, 200, usageQueries.logs(Object.fromEntries(url.searchParams)));

    return;
  }

  if (method === "GET" && url.pathname === "/api/billing/trend") {
    sendJson(res, 200, usageQueries.trend(Object.fromEntries(url.searchParams)));
    return;
  }

  if (method === "GET" && url.pathname === "/api/billing/pricing") {
    sendJson(res, 200, sanitizeBillingConfig(config.billing));
    return;
  }

  if (method === "GET" && url.pathname === "/api/price-lab/exchange-rate") {
    sendJson(res, 200, await exchangeRates.read());
    return;
  }

  if (method === "POST" && url.pathname === "/api/price-lab/exchange-rate") {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await exchangeRates.update(payload));
    return;
  }

  if (method === "GET" && url.pathname === "/api/price-lab") {
    await priceLab.load();
    sendJson(res, 200, priceLab.buildPayload());
    return;
  }

  if (method === "POST" && url.pathname === "/api/price-lab/requests") {
    const payload = await readJsonBody(req);
    const sample = await priceLab.runExperiment(payload);
    sendJson(res, 201, { sample, priceLab: priceLab.buildPayload() });
    return;
  }

  if (
    method === "PUT" &&
    parts[0] === "api" &&
    parts[1] === "price-lab" &&
    parts[2] === "samples" &&
    parts[3]
  ) {
    const payload = await readJsonBody(req);
    const sample = await priceLab.updateSample(decodeURIComponent(parts[3]), payload);
    sendJson(res, 200, { sample, priceLab: priceLab.buildPayload() });
    return;
  }

  if (
    method === "DELETE" &&
    parts[0] === "api" &&
    parts[1] === "price-lab" &&
    parts[2] === "samples" &&
    parts[3]
  ) {
    const deleted = await priceLab.deleteSample(decodeURIComponent(parts[3]));
    sendJson(res, 200, { deleted, priceLab: priceLab.buildPayload() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/price-lab/checkpoints") {
    const payload = await readJsonBody(req);
    const checkpoint = await priceLab.createCheckpoint(payload);
    sendJson(res, 201, { checkpoint, priceLab: priceLab.buildPayload() });
    return;
  }

  if (
    method === "DELETE" &&
    parts[0] === "api" &&
    parts[1] === "price-lab" &&
    parts[2] === "checkpoints" &&
    parts[3]
  ) {
    const deleted = await priceLab.deleteCheckpoint(decodeURIComponent(parts[3]));
    sendJson(res, 200, { deleted, priceLab: priceLab.buildPayload() });
    return;
  }

  if (method === "PUT" && url.pathname === "/api/billing/pricing") {
    const payload = await readJsonBody(req);
    await commitConfig((draft) => updateBillingConfig(payload, draft));
    sendJson(res, 200, sanitizeBillingConfig(config.billing));
    return;
  }

  if (method === "PUT" && url.pathname === "/api/config") {
    const payload = await readJsonBody(req);
    const connectivityChanged = await commitConfig((draft) => {
      updateProxyConfig(payload?.proxy || payload || {}, draft);
      updateUiConfig(payload?.ui, draft);
      return updateConnectivityTestConfig(payload?.connectivityTest, draft);
    });
    if (connectivityChanged) {
      connectivityScheduler?.reschedule();
    }
    sendJson(res, 200, sanitizeConfig(config, groupId));
    return;
  }

  if (method === "POST" && url.pathname === "/api/connectivity/test") {
    if (!connectivityScheduler) {
      sendJson(res, 503, {
        error: { message: "连通性测试调度器尚未启动", type: "service_unavailable" },
      });
      return;
    }
    if (connectivityScheduler.isRunning()) {
      sendJson(res, 409, {
        error: { message: "连通性测试正在进行，请等待本轮完成", type: "test_in_progress" },
      });
      return;
    }
    sendJson(res, 200, await connectivityScheduler.runNow(groupId));
    return;
  }

  if (method === "GET" && url.pathname === "/api/providers") {
    sendJson(res, 200, providersForGroup(config, groupId).map(sanitizeProvider));
    return;
  }

  if (method === "GET" && url.pathname === "/api/oauth-files/discover") {
    sendJson(res, 200, await discoverOAuthFileCandidates());
    return;
  }

  if (method === "POST" && url.pathname === "/api/providers") {
    const payload = await readJsonBody(req);
    const provider = createProvider(payload);
    if (groupId !== "default") setProviderRoutingEnabled(provider, false);
    await commitConfig((draft) => {
      draft.providers.push(provider);
      const defaultGroup = draft.groups.find((group) => group.id === "default");
      if (defaultGroup && !defaultGroup.providerRefs.some((item) => item.providerId === provider.id)) {
        defaultGroup.providerRefs.push({
          providerId: provider.id,
          enabled: true,
          sortIndex: defaultGroup.providerRefs.length + 1,
        });
        defaultGroup.updatedAt = new Date().toISOString();
      }
      if (groupId !== "default") draft.groups.find((group) => group.id === groupId).providerRefs.push({ providerId: provider.id, enabled: true, sortIndex: positiveInt(payload.sortIndex, draft.providers.length) });
      if (groupId === "default" && !draft.proxy.currentProviderId) {
        draft.proxy.currentProviderId = provider.id;
      }
    });
    sendJson(res, 201, { ...sanitizeProvider(provider), ...getGroupProviderRouting(provider, groupId) });
    return;
  }

  if (parts[0] === "api" && parts[1] === "providers" && parts[2]) {
    const providerId = decodeURIComponent(parts[2]);
    const provider = findProvider(providerId);
    if (!provider) {
      sendJson(res, 404, { error: { message: "供应商不存在", type: "not_found" } });
      return;
    }

    if (method === "GET" && parts.length === 3) {
      sendJson(res, 200, { ...provider, ...getGroupProviderRouting(provider, groupId) });
      return;
    }

    if (method === "PUT" && parts.length === 3) {
      const payload = await readJsonBody(req);
      await commitConfig((draft) => {
        const provider = draft.providers.find((item) => item.id === providerId);
        if (groupId === "default") {
          updateProviderConfig(provider, payload);
          sortProviders(draft);
          syncDefaultProviderRef(provider, {
            routing: payload.routingEnabled !== undefined || payload.enabled !== undefined || payload.inFailoverQueue !== undefined,
            sortIndex: payload.sortIndex !== undefined,
          }, draft);
        }
        else {
          const { routingEnabled, enabled, inFailoverQueue, sortIndex, ...sharedPatch } = payload;
          const group = draft.groups.find((item) => item.id === groupId);
          let ref = group.providerRefs.find((item) => item.providerId === providerId);
          if (!ref) { ref = { providerId, enabled: false, sortIndex: group.providerRefs.length + 1 }; group.providerRefs.push(ref); }
          if (routingEnabled !== undefined || enabled !== undefined || inFailoverQueue !== undefined) ref.enabled = Boolean(routingEnabled ?? enabled ?? inFailoverQueue);
          if (sortIndex !== undefined) ref.sortIndex = positiveInt(sortIndex, ref.sortIndex);
          if (Object.keys(sharedPatch).length) updateProviderConfig(provider, sharedPatch);
        }
      });
      clearConfirmedRecovery(providerId);
      sendJson(res, 200, { ...sanitizeProvider(findProvider(providerId)), ...getGroupProviderRouting(findProvider(providerId), groupId) });
      return;
    }

    if (method === "DELETE" && parts.length === 3) {
      await commitConfig((draft) => {
        draft.providers = draft.providers.filter((item) => item.id !== providerId);
        for (const group of draft.groups) {
          group.providerRefs = group.providerRefs.filter((item) => item.providerId !== providerId);
          group.updatedAt = new Date().toISOString();
        }
        if (draft.proxy.currentProviderId === providerId) draft.proxy.currentProviderId = repairManualProviderId(draft.providers);
      });
      recoveryProbeManager?.cancel(provider);
      clearConfirmedRecovery(providerId);
      breakers.delete(providerId);
      for (const store of groupStickyStores.values()) store.forgetProvider(providerId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && parts[3] === "reset") {
      getBreaker(provider).reset();
      sendJson(res, 200, { ok: true, circuit: getBreaker(provider).stats() });
      return;
    }

    if (method === "POST" && parts[3] === "select") {
      if (!provider.baseUrl) {
        sendJson(res, 409, { error: { message: "该供应商缺少有效上游地址，不能设为手动供应商", type: "provider_not_configured" } });
        return;
      }
      await commitConfig((draft) => {
        if (groupId === "default") draft.proxy.currentProviderId = provider.id;
        else draft.groups.find((group) => group.id === groupId).routing.currentProviderId = provider.id;
      });
      setCurrentProvider(findProvider(providerId), "manual_select");
      sendJson(res, 200, sanitizeConfig(config, groupId));
      return;
    }

    if (method === "POST" && parts[3] === "test") {
      const result = await testProvider(provider, undefined, { probeSource: "manual", groupId });
      sendJson(res, 200, await applyProviderTestRoutingResult(provider, result, groupId));
      return;
    }
  }

  if (method === "PUT" && url.pathname === "/api/failover/queue") {
    const payload = await readJsonBody(req);
    const ids = Array.isArray(payload?.ids) ? payload.ids.map(String) : [];
    await commitConfig((draft) => {
      const group = draft.groups.find((item) => item.id === groupId);
      const previous = new Map(group.providerRefs.map((ref) => [ref.providerId, ref]));
      const knownIds = new Set(draft.providers.map((provider) => provider.id));
      const ordered = [...new Set(ids.filter((id) => knownIds.has(id)))];
      if (groupId === "default") {
        for (const ref of group.providerRefs) if (knownIds.has(ref.providerId) && !ordered.includes(ref.providerId)) ordered.push(ref.providerId);
        for (const provider of draft.providers) if (!ordered.includes(provider.id)) ordered.push(provider.id);
      }
      group.providerRefs = ordered.map((providerId, index) => ({ providerId, enabled: previous.get(providerId)?.enabled === true, sortIndex: index + 1 }));
      if (groupId === "default") {
        for (const provider of draft.providers) provider.sortIndex = group.providerRefs.find((ref) => ref.providerId === provider.id)?.sortIndex || provider.sortIndex;
        syncDefaultProviderMirrors(draft);
        sortProviders(draft);
      }
    });
    sendJson(res, 200, providersForGroup(config, groupId).map(sanitizeProvider));
    return;
  }

  sendJson(res, 404, { error: { message: "管理接口不存在", type: "not_found" } });
}

async function handleProxyRequest(req, res, url, requestId, groupId = "default") {
  // 归属由接收请求的监听器确定，客户端请求头不能越组选择供应商。
  const finishGroupRequest = groupStatistics.start(groupId);
  const stickyRouting = getGroupStickyRouting(groupId);
  const proxy = groupProxy(config, groupId);
  req.headers["x-request-id"] = requestId;
  metrics.lastRequestId = requestId;
  metrics.activeConnections += 1;
  metrics.totalRequests += 1;
  metrics.lastRequestAt = new Date().toISOString();
  const requestStartedAt = Date.now();
  let requestModel = null;
  let selectedProvider = null;
  let finalStatusCode = 0;
  let finalError = null;
  let finalFailureClass = "";
  let requestWasStreaming = false;
  let routingContext = null;
  const handoffSessionKey = String(req.headers["x-lite-handoff-session-key"] || "");
  let routeReason = "preferred";
  const providerAttempts = [];
  const requestCancellation = new AbortController();
  let upstreamController = null;
  const onClientClose = () => {
    if (res.writableEnded) return;
    // 已输出后的关闭由 SSE 模块分类；此处补齐连接、首包探测和退避期间的取消。
    // 避免将 SSE 模块因上游失败主动销毁响应的行为误记为客户端取消。
    if (!res.headersSent && !requestCancellation.signal.aborted) {
      requestCancellation.abort(nonRetryableError("客户端连接已断开", 499, "client_connection_closed"));
    }
    upstreamController?.abort();
  };
  const checkClientCancellation = () => {
    if (res.destroyed || req.aborted) onClientClose();
    requestCancellation.signal.throwIfAborted();
  };
  res.once("close", onClientClose);
  req.once("aborted", onClientClose);

  try {
    const body = await readRawBody(req);
    checkClientCancellation();
    requestModel = extractRequestModel(body);
    const route = parseProviderRoute(url.pathname);
    requestWasStreaming = isStreamingRequest(req, normalizeProxyPath(url.pathname), body);
    routingContext = extractRoutingContext(req, body, requestModel, route.routeKey);
    const handoffResponseContextHeader = req.headers["x-lite-handoff-response-context"];
    delete req.headers["x-lite-handoff-response-context"];
    if (HANDOFF_WORKER && routingContext.previousResponseId) {
      const handoffResponseContext = decodeHandoffResponseContext(handoffResponseContextHeader);
      if (handoffResponseContext) {
        routingContext.previousProviderId = handoffResponseContext.providerId;
        routingContext.previousFallbackProviderIds = handoffResponseContext.fallbackProviderIds;
      }
    }
    if (routingContext.previousResponseId) {
      const previousContext = stickyRouting.resolvePreviousResponseContext(
        routingContext.previousResponseId,
        requestModel,
      );
      if (previousContext?.key) {
        routingContext.key = previousContext.key;
        routingContext.previousProviderId = previousContext.providerId;
        routingContext.previousFallbackProviderIds = previousContext.fallbackProviderIds || [];
      }
    }
    const stickyBeforeEntry = routingContext?.previousProviderId
      ? null
      : stickyRouting.get(routingContext?.key);
    const stickyBefore = stickyBeforeEntry?.providerId || "";
    const providers = selectProviders(requestModel, route.routeKey, routingContext, groupId);
    if (routingContext?.previousProviderId) routeReason = "previous_response";
    else if (stickyBeforeEntry?.migratedAt && providers[0]?.id === stickyBefore) routeReason = "recovered_migration";
    else if (stickyBefore && providers[0]?.id === stickyBefore) routeReason = "sticky";
    else if (stickyBefore && providers[0] && isRecoveryConfirmed(providers[0], requestModel)) routeReason = "recovered_migration";
    if (providers.length === 0) {
      metrics.failedRequests += 1;
      finalStatusCode = 503;
      const availability = describeProviderAvailability(requestModel, route.routeKey, groupId);
      finalError = availability.message;
      finalFailureClass = availability.type;
      sendJson(res, 503, {
        error: {
          message: finalError,
          type: availability.type,
        },
      });
      return;
    }

    const maxAttempts = Math.min(30, positiveInt(proxy.maxAttempts, 30));
    const attemptPlan = buildInterleavedAttemptPlan(providers.length, {
      preferredAttempts: positiveInt(proxy.preferredProviderMaxAttempts, 6),
      providerAttempts: positiveInt(proxy.providerMaxAttempts, 2),
      maxAttempts,
      chunkSize: positiveInt(proxy.retryScheduleChunkSize, 2),
    });
    const providerStates = providers.map((provider, index) => ({
      provider,
      index,
      attempts: 0,
      failures: 0,
      exhausted: false,
      circuitFailureObserved: false,
      circuitFailureRecorded: false,
      nextEligibleAt: 0,
      retryStartedAt: null,
      succeeded: false,
    }));
    const requestDeadline = requestStartedAt + positiveInt(proxy.maxRetryElapsedMs, 300_000);
    const scheduledProbeIds = new Set();
    const consumedPlanSlots = new Set();
    let planCursor = 0;
    let lastError = null;
    let attempted = 0;

    while (consumedPlanSlots.size < attemptPlan.length) {
      checkClientCancellation();
      const nowMs = Date.now();
      let planIndex = -1;
      let earliestEligibleAt = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset < attemptPlan.length; offset += 1) {
        const candidateIndex = (planCursor + offset) % attemptPlan.length;
        if (consumedPlanSlots.has(candidateIndex)) continue;
        const candidateState = providerStates[attemptPlan[candidateIndex]];
        if (candidateState.exhausted) {
          consumedPlanSlots.add(candidateIndex);
          continue;
        }
        const eligibleAt = Math.max(nowMs, candidateState.nextEligibleAt || 0);
        earliestEligibleAt = Math.min(earliestEligibleAt, eligibleAt);
        if (eligibleAt <= nowMs) {
          planIndex = candidateIndex;
          break;
        }
      }
      if (planIndex < 0) {
        if (!Number.isFinite(earliestEligibleAt) || earliestEligibleAt >= requestDeadline) break;
        await waitForRetry(Math.max(1, earliestEligibleAt - nowMs), requestCancellation.signal);
        continue;
      }
      consumedPlanSlots.add(planIndex);
      planCursor = (planIndex + 1) % Math.max(1, attemptPlan.length);
      const state = providerStates[attemptPlan[planIndex]];
      const provider = state.provider;
      if (planIndex > 0 && routeReason === "preferred") routeReason = "failover";
      const hasNextAttempt = attemptPlan.some((providerIndex, index) =>
        index > planIndex && providerIndex === state.index && !consumedPlanSlots.has(index),
      );
      if (Date.now() >= requestDeadline) break;

      const breaker = getBreaker(provider);
      const permit = providers.length === 1
        ? { allowed: true, usedHalfOpenPermit: false }
        : breaker.allowRequest();
      const circuitStateBefore = breaker.stats().state;
      if (!permit.allowed) {
        appendProviderAttempt(providerAttempts, provider, {
          outcome: "skipped",
          affectsCircuit: false,
          failureClass: "circuit_unavailable",
          error: "断路器未授予请求许可",
          circuitStateBefore,
          providerAttempt: state.attempts + 1,
        });
        continue;
      }

      attempted += 1;
      state.attempts += 1;
      const attemptStartedAt = Date.now();
      state.retryStartedAt ??= attemptStartedAt;
      selectedProvider = provider;
      // 每次真正发起上游请求前立即推送，4xx、5xx、超时也能显示实际尝试的供应商。
      setCurrentProvider(provider, "proxy_attempt");

      let finishActivity;
      const lifecycle = requestLifecycle.start({
        requestId,
        attempt: state.attempts,
        groupId,
        providerId: provider.id,
        providerName: provider.name,
        model: requestModel,
        endpoint: normalizeProxyPath(url.pathname),
        stream: requestWasStreaming,
        state: "connecting",
        clientAddress: req.socket?.remoteAddress,
        clientPort: req.socket?.remotePort,
      });
      try {
        const result = await forwardToProvider(req, url, body, provider, ({ controller, targetUrl }) => {
          upstreamController = controller;
          checkClientCancellation();
          finishActivity = providerActivity.start(provider, "business", groupId);
          lifecycle.setAbort(() => controller.abort());
          lifecycle.update({
            state: requestWasStreaming ? "probing" : "reading",
            upstreamHost: new URL(targetUrl).host,
          });
        }, proxy, lifecycle);
        checkClientCancellation();
        finalStatusCode = result.status;
        const initialResponseIds = result.mode === "buffer"
          ? extractResponseIds(result.body, null)
          : extractResponseIds(null, Buffer.from(result.firstChunk || []).toString("utf8"));
        stickyRouting.rememberSuccess(routingContext?.key, provider.id, initialResponseIds, requestModel);
        await writeProviderResponse(
          res, result, req, provider,
          {
            startedAt: requestStartedAt,
            groupId,
            proxy,
            requestModel,
            endpoint: normalizeProxyPath(url.pathname),
            providerAttempts,
            routeReason,
            requestId,
            attemptStartedAt,
            providerAttempt: state.attempts,
            circuitStateBefore,
            usedHalfOpenPermit: permit.usedHalfOpenPermit,
            lifecycle,
            onSuccess: async (responseIds) => {
              reconcileCompletedStickyProvider({
                stickyRouting,
                routingContext,
                completedProvider: provider,
                responseIds,
                requestModel,
                routeKey: route.routeKey,
                groupId,
              });
              try { await recoveryProbeManager?.recordSuccess(findProvider(provider.id) || provider, requestModel, { source: "business", status: finalStatusCode }); }
              catch (error) { console.error(`恢复确认同步失败，保留现有连接：${error.message}`); }
              if (HANDOFF_WORKER && handoffSessionKey) {
                try {
                  const responseContext = responseIds
                    .map((responseId) => stickyRouting.resolvePreviousResponseContext(responseId, requestModel))
                    .find((context) => context?.providerId);
                  pendingSessionCheckpoints.set(JSON.stringify([handoffSessionKey, requestId]), {
                    workerId: HANDOFF_WORKER_ID || `${BUILD_INFO.releaseId}:${process.pid}`,
                    workerPid: process.pid,
                    sessionKey: handoffSessionKey,
                    responseIds,
                    providerId: responseContext?.providerId || provider.id,
                    fallbackProviderIds: responseContext?.fallbackProviderIds || [],
                    completed: true,
                    checkpointRequestId: requestId,
                    model: requestModel,
                  });
                  await flushResponseContexts();
                } catch (checkpointError) {
                  // 检查点只用于后续版本选择，不能因监督器短暂断开破坏已经完成的业务响应。
                  console.error(`会话交接检查点写入失败：${checkpointError.message}`);
                }
              }
              return;
            },
          },
        );
        lifecycle.finish({ state: "completed", completed: true, terminationReason: "completed" });
        finishActivity?.();
        breaker.recordSuccess(permit.usedHalfOpenPermit);
        state.succeeded = true;
        await commitProviderEvidence(provider.id, requestModel, "supported", "actual_request", "request_succeeded")
          .catch((error) => console.error(`业务成功后的模型证据保存失败：${error.message}`));
        if (planIndex > 0) metrics.failoverCount += 1;
        metrics.successRequests += 1;
        metrics.lastError = null;
        recordDeferredCircuitFailures(providerStates);
        await maybeSaveCurrentProvider(provider.id, false, groupId).catch((error) => console.error(`手动供应商保存失败：${error.message}`));
        return;
      } catch (error) {
        if (res.destroyed || req.aborted) onClientClose();
        if (requestCancellation.signal.aborted) {
          const cancelledError = requestCancellation.signal.reason;
          cancelledError.streamDiagnostics = error.streamDiagnostics;
          cancelledError.upstreamUsage = error.upstreamUsage;
          error = cancelledError;
        } else if (lifecycle.isCancelled()) {
          error.retryable = false;
          error.status = 499;
          error.affectsCircuit = false;
          error.failureClass = "operator_cancelled";
        }
        if (requestWasStreaming) {
          error.streamDiagnostics = {
            ...(error.streamDiagnostics || {}),
            ...lifecycle.timingDiagnostics(),
          };
        }
        lifecycle.finish({
          state: requestCancellation.signal.aborted || lifecycle.isCancelled() ? "cancelled" : "failed",
          terminationReason: lifecycle.isCancelled() ? "operator_cancelled" : classifyProxyFailure(error),
        });
        finishActivity?.();
        lastError = error;
        if (shouldInvalidateSticky(error)) stickyRouting.markFailure(routingContext?.key, provider.id);
        const failureClass = classifyProxyFailure(error);
        if (failureClass === "response_context_incompatible" || routingContext?.previousProviderId && planIndex > 0) {
          routeReason = "previous_response_fallback";
        }
        // 413 诊断是显式 arm 的一次性旁路，不改变本次请求的路由结果。
        if (error.status === 413) {
          await payloadDiagnostics.capture({
            groupId,
            provider,
            providerId: provider.id,
            providerName: provider.name,
            requestModel,
            method: req.method,
            pathname: normalizeProxyPath(url.pathname),
            search: url.search,
            headers: req.headers,
            body,
          });
        }
        if (error.retryable) {
          const affectsCircuit = error.affectsCircuit !== false;
          if (affectsCircuit) clearConfirmedRecovery(provider, requestModel);
          if (permit.usedHalfOpenPermit && affectsCircuit) {
            breaker.recordFailure(true);
            state.circuitFailureRecorded = true;
          } else if (affectsCircuit) {
            state.circuitFailureObserved = true;
            state.failures += 1;
            breaker.releaseHalfOpenPermit(false);
          } else {
            breaker.releaseHalfOpenPermit(false);
          }
          if (
            affectsCircuit &&
            !["model_unsupported", "provider_payload_limit", "provider_compatibility"].includes(failureClass) &&
            !scheduledProbeIds.has(provider.id)
          ) {
            recoveryProbeGroups.set(provider.id, groupId);
            recoveryProbeManager?.schedule(findProvider(provider.id) || provider, "business_failure", requestModel);
            scheduledProbeIds.add(provider.id);
          }
          const retryDelayMs = state.attempts <= 1
            ? 0
            : providerRetryDelay({
              providerIndex: state.index,
              providerAttempt: state.attempts,
              failureClass,
              providerElapsedMs: Date.now() - state.retryStartedAt,
              proxyConfig: proxy,
            });
          if ([
            "model_unsupported",
            "provider_payload_limit",
            "provider_compatibility",
            "response_context_incompatible",
          ].includes(failureClass)) {
            // 供应商能力差异或请求大小限制不是短暂网络故障；本次请求不在该供应商上重复发送。
            state.exhausted = true;
          }
          state.nextEligibleAt = Math.max(state.nextEligibleAt, Date.now() + (hasNextAttempt ? retryDelayMs : 0));
          appendProviderAttempt(providerAttempts, provider, {
            startedAtMs: attemptStartedAt,
            statusCode: error.status || 502,
            outcome: "failure",
            retryable: true,
            affectsCircuit,
            failureClass,
            error: error.message,
            circuitStateBefore,
            usedHalfOpenPermit: permit.usedHalfOpenPermit,
            providerAttempt: state.attempts,
            retryDelayMs: hasNextAttempt ? retryDelayMs : 0,
            streamDiagnostics: error.streamDiagnostics,
            usage: error.upstreamUsage,
          });
          metrics.lastError = `${provider.name}: ${error.message}`;
          if (failureClass === "model_unsupported") await commitProviderEvidence(provider.id, requestModel,
            "unsupported", "upstream_error", "model_unsupported").catch((saveError) => console.error(`模型证据保存失败：${saveError.message}`));
          if (res.headersSent) {
            if (affectsCircuit && !state.circuitFailureRecorded) {
              breaker.recordFailure(permit.usedHalfOpenPermit);
              state.circuitFailureRecorded = true;
            }
            recordDeferredCircuitFailures(providerStates);
            throw error;
          }
          continue;
        }
        recordDeferredCircuitFailures(providerStates);
        breaker.releaseHalfOpenPermit(permit.usedHalfOpenPermit);
        appendProviderAttempt(providerAttempts, provider, {
          startedAtMs: attemptStartedAt,
          statusCode: error.status || 502,
          outcome: "failure",
          retryable: false,
          affectsCircuit: false,
          failureClass,
          error: error.message,
          circuitStateBefore,
          usedHalfOpenPermit: permit.usedHalfOpenPermit,
          providerAttempt: state.attempts,
          streamDiagnostics: error.streamDiagnostics,
          usage: error.upstreamUsage,
        });
        throw error;
      } finally {
        upstreamController = null;
        lifecycle.finish({ state: "finished", terminationReason: "attempt_finished" });
        finishActivity?.();
      }
    }

    // 请求内暂存的供应商失败只在预算耗尽后计入断路器，避免 6/2 次重试过早打开断路器。
    recordDeferredCircuitFailures(providerStates);

    metrics.failedRequests += 1;
    const message = lastError?.message || "所有供应商均不可用";
    metrics.lastError = message;
    finalStatusCode = lastError?.status || 503;
    finalError = message;
    finalFailureClass = classifyProxyFailure(lastError);
    const exhaustedResponse = {
      error: {
        message,
        type: "failover_exhausted",
        attempted,
      },
    };
    if (!res.headersSent) sendJson(res, lastError?.status || 503, exhaustedResponse);
    else if (!res.destroyed) res.destroy(lastError || new Error(message));
  } catch (error) {
    if (res.destroyed || req.aborted) onClientClose();
    // 请求体上限等明确的本地错误保留原分类；读取中断等原生异常才补充取消原因。
    if (requestCancellation.signal.aborted && error.retryable !== false) error = requestCancellation.signal.reason;
    metrics.failedRequests += 1;
    metrics.lastError = error instanceof Error ? error.message : String(error);
    finalStatusCode = error.status || 502;
    finalError = metrics.lastError;
    finalFailureClass = classifyProxyFailure(error);
    if (!res.destroyed && !res.headersSent) {
      sendJson(res, error.status || 502, {
        error: {
          message: metrics.lastError,
          type: error.retryable ? "retryable_proxy_error" : "proxy_error",
        },
      });
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  } finally {
    res.off("close", onClientClose);
    req.off("aborted", onClientClose);
    try {
      if (finalError) await recordUsage({
        groupId,
        provider: selectedProvider,
        endpoint: normalizeProxyPath(url.pathname),
        requestModel,
        statusCode: finalStatusCode || 502,
        latencyMs: Date.now() - requestStartedAt,
        isStreaming: requestWasStreaming,
        error: finalError,
        failureClass: finalFailureClass,
        providerAttempts,
        routeReason,
        requestId,
      });
    } finally {
      finishGroupRequest({
        statusCode: finalStatusCode,
        error: finalError,
        providerAttempts,
        isStreaming: requestWasStreaming,
        timestamp: new Date().toISOString(),
      });
      metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
      publishRuntimeStatusUpdate();
    }
  }
}

async function forwardToProvider(clientReq, url, originalBody, provider, onUpstreamRequest, proxy = config.proxy, lifecycle = null) {
  const streamPolicy = normalizeStreamPolicy(proxy);
  const requestPath = normalizeProxyPath(url.pathname);
  const targetUrl = joinUpstreamUrl(provider.baseUrl, requestPath, url.search, provider);
  const isStreaming = isStreamingRequest(clientReq, requestPath, originalBody);
  const body = rectifyRequestBody(provider, originalBody);
  const headers = await buildUpstreamHeaders(clientReq, provider);
  const controller = new AbortController();
  const firstByteTimeout = positiveInt(
    proxy.streamingFirstByteTimeoutMs,
    60_000,
  );
  const nonStreamingTimeout = positiveInt(
    proxy.nonStreamingTimeoutMs,
    600_000,
  );
  const headerTimeout = isStreaming ? firstByteTimeout : nonStreamingTimeout;

  let headerTimer = setTimeout(() => controller.abort(), headerTimeout);
  let response;
  try {
    onUpstreamRequest({ controller, targetUrl, isStreaming });
    response = await fetch(targetUrl, {
      method: clientReq.method,
      headers,
      body: shouldSendBody(clientReq.method) ? body : undefined,
      signal: controller.signal,
      dispatcher: getProviderDispatcher(provider),
    });
  } catch (error) {
    throw retryableError(`连接上游失败: ${formatFetchError(error)}`);
  } finally {
    clearTimeout(headerTimer);
  }

  if (!response.ok) {
    const errorBodyTimeout = isStreaming
      ? positiveInt(proxy.streamingIdleTimeoutMs, firstByteTimeout)
      : nonStreamingTimeout;
    const text = await readUpstreamErrorBody(response, controller, errorBodyTimeout);
    const unsupportedModel = isUnsupportedModelText(text);
    const compatibilityError = detectKnownProviderCompatibilityError(response.status, text);
    const payloadLimitError = detectKnownProviderPayloadLimitError(response.status, text);
    const responseContextError = detectKnownResponseContextError(response.status, text);
    const oauthFileAuthRejected = provider.authMode === "oauth_file" && response.status === 401;
    const retryable = isRetryableStatus(response.status) ||
      unsupportedModel ||
      isCapacityText(text) ||
      Boolean(compatibilityError) ||
      Boolean(payloadLimitError) ||
      Boolean(responseContextError);
    const error = upstreamError(
      response.status,
      text,
      retryable,
      oauthFileAuthRejected
        ? false
        : compatibilityError || payloadLimitError || responseContextError
          ? false
          : !unsupportedModel,
      compatibilityError?.failureClass ||
        payloadLimitError?.failureClass ||
        responseContextError?.failureClass ||
        "",
    );
    const matchedRule = compatibilityError || payloadLimitError || responseContextError;
    if (matchedRule) error.compatibilityRuleId = matchedRule.ruleId;
    error.upstreamUsage = extractUsage(null, text);
    throw error;
  }

  // 仅在上游已接受真实业务请求后缓存会话头，避免把无效凭据用于后台探测。
  clientSessionContexts.remember(provider, clientReq.headers);

  if (isStreaming) {
    if (!response.body) {
      throw retryableError("上游没有返回可读流");
    }
    const reader = response.body.getReader();
    const firstChunk = await readFirstChunk(reader, firstByteTimeout, controller);
    // probe idle timeout: use configured idle timeout, fall back to firstByteTimeout
    const probeIdleMs = positiveInt(proxy.streamingIdleTimeoutMs, 0) || firstByteTimeout;
    let probeResult;
    try {
      probeResult = await probeSseStream(
        reader,
        firstChunk,
        probeIdleMs,
        controller,
        (bytes, patch) => lifecycle?.observeChunk(bytes, patch),
        { progressTimeoutMs: streamPolicy.streamingProgressTimeoutMs },
      );
    } catch (error) {
      throw attachStreamDiagnostics(
        error,
        buildSseDiagnostics(null, Buffer.byteLength(firstChunk), "probe_error"),
      );
    }
    const { preamble, sseInspector, sseDiagnostics } = probeResult;
    return {
      mode: "stream",
      status: response.status,
      headers: response.headers,
      firstChunk: preamble,
      reader,
      controller,
      sseInspector,
      sseDiagnostics,
      streamPolicy,
      requestBody: body,
    };
  }

  const bodyTimer = setTimeout(() => controller.abort(), nonStreamingTimeout);
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    const payloadError = detectUpstreamPayloadError(buffer.toString("utf8"));
    if (payloadError) {
      const error = upstreamError(
        payloadError.status,
        payloadError.message,
        payloadError.retryable,
        payloadError.affectsCircuit !== false && !isUnsupportedModelText(payloadError.message),
      );
      error.upstreamUsage = extractUsage(buffer, null);
      throw error;
    }
    return {
      mode: "buffer",
      status: response.status,
      headers: response.headers,
      body: buffer,
      requestBody: body,
    };
  } catch (error) {
    if (error?.status || error?.retryable !== undefined) {
      throw error;
    }
    throw retryableError(`读取上游响应失败: ${formatFetchError(error)}`);
  } finally {
    clearTimeout(bodyTimer);
  }
}

async function writeProviderResponse(res, result, clientReq, provider, usageContext) {
  const applyResponseHeaders = () => {
    copyResponseHeaders(res, result.headers, result.mode);
    res.setHeader("x-request-id", usageContext.requestId);
    res.setHeader("x-lite-ccswitch-instance-id", SERVER_INSTANCE_ID);
    res.statusCode = result.status;
    res.setHeader("x-lite-ccswitch-provider-id", provider.id);
    res.setHeader("x-lite-ccswitch-provider-name", encodeURIComponent(provider.name));
  };
  const startStreamingResponse = () => {
    usageContext.lifecycle?.markClientOutputStarted?.();
    applyResponseHeaders();
  };

  if (result.mode === "buffer") {
    applyResponseHeaders();
    const attemptUsage = extractUsage(result.body, null);
    usageContext.lifecycle?.observeChunk(result.body.length, {
      state: "completed",
      semanticStarted: true,
      completed: true,
    });
    res.end(result.body);
    // 在完整响应结束时确认恢复，不能等日志落盘后才让旧成功覆盖后来的失败。
    await usageContext.onSuccess?.(extractResponseIds(result.body, null));
    appendProviderAttempt(usageContext.providerAttempts, provider, {
      startedAtMs: usageContext.attemptStartedAt,
      statusCode: result.status,
      outcome: "success",
      providerAttempt: usageContext.providerAttempt,
      circuitStateBefore: usageContext.circuitStateBefore,
      usedHalfOpenPermit: usageContext.usedHalfOpenPermit,
      usage: attemptUsage,
    });
    await recordUsage({
      groupId: usageContext.groupId,
      provider,
      endpoint: usageContext.endpoint,
      requestModel: usageContext.requestModel,
      requestId: usageContext.requestId,
      routeReason: usageContext.routeReason,
      upstreamRequestId: result.headers.get("x-request-id") || result.headers.get("request-id") || "",
      statusCode: result.status,
      latencyMs: Date.now() - usageContext.startedAt,
      isStreaming: false,
      responseBody: result.body,
      requestBody: result.requestBody,
      providerAttempts: usageContext.providerAttempts,
    });
    return {
      responseIds: extractResponseIds(result.body, null),
    };
  }

  activeStreamingResponses.add(res);
  // 流式响应结束或异常退出后主动移除监听器，避免同一响应对象在重试/复用时累积 close 监听。
  const removeActiveStreamingResponse = () => activeStreamingResponses.delete(res);
  res.once("close", removeActiveStreamingResponse);
  let streamResult;
  try {
    // 只有前导生命周期事件尚未产生有效输出时才延迟转发，给安全回退保留窗口。
    streamResult = await pipeReadableStream(
      res,
      result.reader,
      result.controller,
      result.firstChunk,
      result.sseInspector,
      result.sseDiagnostics,
      usageContext.proxy?.streamingIdleTimeoutMs,
      usageContext.lifecycle,
      Boolean(!result.sseInspector?.semanticStarted && !result.sseInspector?.completed),
      startStreamingResponse,
      result.streamPolicy,
    );
  } finally {
    removeActiveStreamingResponse();
    res.off("close", removeActiveStreamingResponse);
  }
  const { text: streamText } = streamResult;
  streamResult.diagnostics = {
    ...streamResult.diagnostics,
    ...usageContext.lifecycle?.timingDiagnostics?.(),
  };
  await usageContext.onSuccess?.(extractResponseIds(null, streamText));
  const attemptUsage = extractUsage(null, streamText);
  appendProviderAttempt(usageContext.providerAttempts, provider, {
    startedAtMs: usageContext.attemptStartedAt,
    statusCode: result.status,
    outcome: "success",
    providerAttempt: usageContext.providerAttempt,
    streamDiagnostics: streamResult.diagnostics,
    circuitStateBefore: usageContext.circuitStateBefore,
    usedHalfOpenPermit: usageContext.usedHalfOpenPermit,
    usage: attemptUsage,
  });
  await recordUsage({
    groupId: usageContext.groupId,
    provider,
    endpoint: usageContext.endpoint,
    requestModel: usageContext.requestModel,
    requestId: usageContext.requestId,
    routeReason: usageContext.routeReason,
    upstreamRequestId: result.headers.get("x-request-id") || result.headers.get("request-id") || "",
    statusCode: result.status,
    latencyMs: Date.now() - usageContext.startedAt,
    isStreaming: true,
    responseText: streamText,
    requestBody: result.requestBody,
    providerAttempts: usageContext.providerAttempts,
  });
  return {
    responseIds: extractResponseIds(null, streamText),
  };
}

async function pipeReadableStream(
  res,
  reader,
  controller,
  firstChunk,
  sseInspector,
  probeDiagnostics,
  idleTimeoutMs = config.proxy.streamingIdleTimeoutMs,
  lifecycle = null,
  deferUntilSemantic = false,
  onStart = () => {},
  streamPolicy = config.proxy,
) {
  return pipeSseReadableStream(
    res,
    reader,
    controller,
    firstChunk,
    sseInspector,
    probeDiagnostics,
    {
      idleTimeoutMs: Number(idleTimeoutMs || 0),
      progressTimeoutMs: streamPolicy.streamingProgressTimeoutMs,
      deferredOutputGraceMs: streamPolicy.streamingDeferredOutputGraceMs,
      deferredBufferLimit: streamPolicy.streamingDeferredBufferBytes,
      onStart: () => {
        lifecycle?.markClientOutputStarted?.();
        onStart();
      },
      onChunk: (bytes, patch) => lifecycle?.observeChunk(bytes, patch),
      deferUntilSemantic,
      onError: (message) => { metrics.lastError = message; },
      extractUsage,
    },
  );
}

function buildStatusPayload() {
  const uptimeSeconds = Math.floor(
    (Date.now() - new Date(metrics.startedAt).getTime()) / 1000,
  );
  const successRate =
    metrics.totalRequests > 0
      ? (metrics.successRequests / metrics.totalRequests) * 100
      : 0;
  const statusProvider = getStatusCurrentProvider();

  return {
    running: true,
    build: BUILD_INFO,
    instanceId: SERVER_INSTANCE_ID,
    processId: process.pid,
    startedAt: metrics.startedAt,
    address: LISTEN_HOST,
    port: LISTEN_PORT,
    publicPort: PUBLIC_LISTEN_PORT,
    handoff: {
      worker: HANDOFF_WORKER,
      readOnly: handoffReadOnly,
      continuation: handoffContinuation,
      responseContextSync: { ...responseContextSync.state(), pendingCheckpoints: pendingSessionCheckpoints.size },
      configCommit: { ...configTransactions.state(), revision: committedConfigRevision },
      workerId: HANDOFF_WORKER_ID || `${BUILD_INFO.releaseId}:${process.pid}`,
      actualMainPort: LISTEN_PORT,
      pendingRequests: Math.max(0, activeRequests.size - 1),
    },
    uptimeSeconds,
    activeConnections: metrics.activeConnections,
    totalRequests: metrics.totalRequests,
    successRequests: metrics.successRequests,
    failedRequests: metrics.failedRequests,
    successRate,
    failoverCount: metrics.failoverCount,
    lastRequestAt: metrics.lastRequestAt,
    lastError: metrics.lastError,
    lastRequestId: metrics.lastRequestId,
    currentProviderId: statusProvider?.id || null,
    currentProviderName: statusProvider?.name || null,
    currentProviderUpdatedAt: metrics.currentProviderUpdatedAt,
    currentProviderSource: metrics.currentProviderSource,
    runtimeProviderId: statusProvider?.id || null,
    runtimeProviderName: statusProvider?.name || null,
    manualProviderId: config.proxy.currentProviderId || null,
    providerActivity: providerActivity.snapshot(),
    activeRequests: requestLifecycle.stats({ idleTimeoutMs: config.proxy.streamingIdleTimeoutMs }),
    streamDiagnostics: groupStatistics.snapshot("default").streamDiagnostics,
    statusRevision: metrics.statusRevision,
    // 顶层供应商状态对应主端口的默认分组，和 /api/providers?groupId=default 保持一致。
    providers: providersForGroup(config, "default").map((provider) => ({
      ...sanitizeProvider(provider),
      circuit: getBreaker(provider).stats(),
    })),
    groups: config.groups.map((group) => ({
      ...buildGroupStatus(group),
      providerCount: group.providerRefs.length,
      activeProviderCount: providersForGroup(config, group.id).filter(isProviderInAutoRouting).length,
    })),
    connectivityTest: {
      candidateModels: [...(config.connectivityTest?.candidateModels || [])],
      ...(connectivityScheduler
        ? connectivityScheduler.status()
        : {
        periodicIntervalMs: config.connectivityTest?.periodicIntervalMs ?? null,
        nextRunAt: null,
        lastRunAt: null,
        lastRunReason: null,
        running: false,
        }),
    },
    ui: {
      groupThemeEnabled: config.ui?.groupThemeEnabled !== false,
      palette: config.ui?.palette || "ocean",
    },
    proxy: sanitizeConfig(config).proxy,
    resources: buildResourcePayload(),
    stickyRouting: [...groupStickyStores.values()].map((store) => store.stats()).reduce((total, stats) => ({ entries: total.entries + stats.entries, responseAliases: total.responseAliases + stats.responseAliases }), { entries: 0, responseAliases: 0 }),
    recoveryProbes: recoveryProbeManager?.status() || [],
    diagnostics413: payloadDiagnostics.status(),
    persistence: {
      configPath: CONFIG_PATH,
      usagePath: USAGE_PATH,
      priceLabPath: PRICE_LAB_PATH,
      usageRecordCount: usageState.records.length,
      logPageLimit: usageState.maxRecords,
      malformedRecordCount: usageState.malformedCount,
      loaded: usageState.loaded,
      mode: "append_only",
      lastWriteAt: usageState.lastWriteAt,
      lastWriteError: usageState.lastWriteError,
      lastReadError: usageState.lastReadError,
      failedWrites: usageState.failedWrites,
    },
    security: {
      loopbackOnly: IS_LOOPBACK,
      proxyTokenConfigured: Boolean(PROXY_TOKEN),
      adminTokenConfigured: Boolean(ADMIN_TOKEN),
    },
  };
}

function normalizeRequestId(value) {
  const normalized = Array.isArray(value) ? value[0] : value;
  const text = String(normalized || "").trim();
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(text) ? text : "";
}

function openStatusStream(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 1000\n\n");
  statusSubscribers.add(res);
  res.once("close", () => statusSubscribers.delete(res));
  writeStatusStreamEvent(res, buildStatusPayload());
}

function publishStatusUpdate() {
  if (statusSubscribers.size === 0) return;
  const payload = buildStatusPayload();
  for (const res of statusSubscribers) {
    writeStatusStreamEvent(res, payload);
  }
}

function writeStatusStreamEvent(res, payload) {
  if (res.destroyed || res.writableEnded) {
    statusSubscribers.delete(res);
    return;
  }
  try {
    res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    statusSubscribers.delete(res);
  }
}

function closeStatusSubscribers() {
  for (const res of statusSubscribers) {
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  statusSubscribers.clear();
}

// 当前供应商表示最近一次已发起的业务上游尝试，包含 4xx、5xx 和超时；检测请求不会改写它。
function setCurrentProvider(provider, source) {
  metrics.currentProviderId = provider?.id || null;
  metrics.currentProviderName = provider?.name || null;
  metrics.currentProviderUpdatedAt = new Date().toISOString();
  metrics.currentProviderSource = source || null;
  publishRuntimeStatusUpdate();
}

function publishRuntimeStatusUpdate() {
  metrics.statusRevision += 1;
  publishStatusUpdate();
}

function buildResourcePayload() {
  const now = Date.now();
  if (resourceSampler.cachedPayload && now - resourceSampler.lastSampledAtMs < 30_000) {
    return resourceSampler.cachedPayload;
  }

  const memory = process.memoryUsage();
  const nextCpuUsage = process.cpuUsage();
  const nextHrtimeNs = process.hrtime.bigint();
  const elapsedUs = Number(nextHrtimeNs - resourceSampler.lastHrtimeNs) / 1000;
  const cpuDeltaUs =
    nextCpuUsage.user +
    nextCpuUsage.system -
    resourceSampler.lastCpuUsage.user -
    resourceSampler.lastCpuUsage.system;

  // 首次访问可能只经过几十毫秒，忽略这段启动瞬时值，避免把初始化开销显示成长期 CPU 占用。
  if (elapsedUs >= 1_000_000) {
    resourceSampler.lastCpuPercent = Math.max(0, (cpuDeltaUs / elapsedUs) * 100);
    resourceSampler.lastCpuSampleWindowSeconds = elapsedUs / 1_000_000;
    resourceSampler.lastCpuUsage = nextCpuUsage;
    resourceSampler.lastHrtimeNs = nextHrtimeNs;
  }

  const payload = {
    sampledAt: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    cpuPercent: roundNumber(resourceSampler.lastCpuPercent, 1),
    cpuPercentOfSystem: roundNumber(resourceSampler.lastCpuPercent / CPU_PARALLELISM, 1),
    cpuParallelism: CPU_PARALLELISM,
    cpuSampleWindowSeconds: roundNumber(resourceSampler.lastCpuSampleWindowSeconds, 1),
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      rssMb: bytesToMb(memory.rss),
      heapUsedMb: bytesToMb(memory.heapUsed),
      heapTotalMb: bytesToMb(memory.heapTotal),
      externalMb: bytesToMb(memory.external),
    },
  };
  resourceSampler.cachedPayload = payload;
  resourceSampler.lastSampledAtMs = now;
  return payload;
}

function getStatusCurrentProvider() {
  const configured = config.providers.filter((provider) => provider.baseUrl);
  if (!configured.length) return null;
  const liveProvider = configured.find(
    (provider) => provider.id === metrics.currentProviderId,
  );
  if (liveProvider) return liveProvider;
  if (config.proxy.autoFailoverEnabled) return null;
  return configured.find(
    (provider) => provider.id === config.proxy.currentProviderId,
  ) || null;
}

async function loadUsageRecords() {
  const loaded = await readUsageRecords(USAGE_PATH);
  usageState.records = loaded.records;
  usageQueries.invalidate();
  usageState.malformedCount = loaded.malformedCount;
  usageState.fileSignature = loaded.signature;
  usageState.fileInode = loaded.inode;
  usageState.fileOffset = loaded.offset || 0;
  usageState.fileRemainder = loaded.remainder || "";
  usageState.recordKeys = new Set(loaded.records.map((record) => record.id || JSON.stringify(record)));
  usageState.loaded = true;
}

function usageRecordKey(record) {
  return record.id || JSON.stringify(record);
}

function mergeRefreshedUsageRecords(records) {
  for (const record of records) {
    const key = usageRecordKey(record);
    if (usageState.recordKeys.has(key)) continue;
    usageState.recordKeys.add(key);
    usageState.records.push(record);
    usageQueries.invalidate();
    groupStatistics.record(record);
    if (isProviderTestUsageRecord(record)) continue;
    metrics.totalRequests += 1;
    const success = record.statusCode >= 200 && record.statusCode < 400 && !record.error;
    if (success) metrics.successRequests += 1;
    else metrics.failedRequests += 1;
    if ((record.providerAttempts || []).some((attempt) => attempt.sequence > 1 && attempt.outcome === "success")) {
      metrics.failoverCount += 1;
    }
  }
}

// 滚动重启时旧进程可能晚于新进程启动才完成请求；管理台刷新时合并新增的落盘记录。
async function refreshUsageRecords() {
  const task = usageRefreshQueue.catch(() => {}).then(async () => {
    await usageWriteQueue;
    let metadata;
    try {
      metadata = await usageFileMetadata(USAGE_PATH);
    } catch (error) {
      if (error.code === "ENOENT" && usageState.fileSignature === null) return;
      throw error;
    }
    if (metadata.signature === usageState.fileSignature) return;
    let loaded;
    if (metadata.inode === usageState.fileInode && metadata.size >= usageState.fileOffset) {
      loaded = await loadUsageRecordsFromOffset(USAGE_PATH, usageState.fileOffset, usageState.fileRemainder);
    } else {
      loaded = { reset: true };
    }
    if (loaded.reset || loaded.inode !== usageState.fileInode) {
      const full = await readUsageRecords(USAGE_PATH);
      usageState.records = full.records;
      usageQueries.invalidate();
      usageState.recordKeys = new Set(full.records.map(usageRecordKey));
      usageState.malformedCount = full.malformedCount;
      usageState.fileSignature = full.signature;
      usageState.fileInode = full.inode;
      usageState.fileOffset = full.offset || 0;
      usageState.fileRemainder = full.remainder || "";
      restoreRuntimeMetrics();
      return;
    }
    usageState.fileSignature = loaded.signature;
    usageState.fileInode = loaded.inode;
    usageState.fileOffset = loaded.offset;
    usageState.fileRemainder = loaded.remainder;
    usageState.malformedCount += loaded.malformedCount;
    mergeRefreshedUsageRecords(loaded.records);
    usageState.lastReadError = null;
  }).catch((error) => {
    usageState.lastReadError = error.message;
  });
  usageRefreshQueue = task;
  await task;
}

// 从持久化请求日志恢复管理台累计指标，避免服务重启后统计从零开始。
function restoreRuntimeMetrics() {
  groupStatistics.restore(usageState.records);
  // 连通性探测也会写入计费日志，但不能被误认为 Codex 的真实路由请求。
  const records = usageState.records.filter((record) => !isProviderTestUsageRecord(record));
  metrics.totalRequests = records.length;
  metrics.successRequests = records.filter((record) => {
    const status = Number(record.statusCode || 0);
    return status >= 200 && status < 400 && !record.error;
  }).length;
  metrics.failedRequests = Math.max(0, metrics.totalRequests - metrics.successRequests);
  metrics.failoverCount = records.filter((record) =>
    (record.providerAttempts || []).some((attempt) =>
      Number(attempt.sequence || 0) > 1 && attempt.outcome === "success",
    ),
  ).length;
  const latest = records.at(-1);
  const latestSuccessful = [...records].reverse().find((record) => {
    const status = Number(record.statusCode || 0);
    return status >= 200 && status < 400 && !record.error && record.providerId;
  });
  metrics.lastRequestAt = latest?.timestamp || null;
  metrics.lastRequestId = latest?.requestId || null;
  metrics.lastError = latest?.error || null;
  metrics.currentProviderId = latestSuccessful?.providerId || null;
  metrics.currentProviderName = latestSuccessful?.providerName || null;
  metrics.currentProviderUpdatedAt = latestSuccessful?.timestamp || null;
  metrics.currentProviderSource = latestSuccessful ? "restored_proxy_usage" : null;
  metrics.statusRevision = latestSuccessful ? 1 : 0;
}

async function recordProviderTestUsage(targetProvider, input, options = {}) {
  if (options.recordUsage === false) return;
  await recordUsage({
    ...input,
    // CCOK 只是流量类别；供应商字段必须保留实际被探测的目标。
    provider: targetProvider,
    usageCategory: "ccok_probe",
    probeSource: String(options.probeSource || "manual"),
    groupId: options.groupId || "default",
    targetProviderId: targetProvider?.id || null,
    targetProviderName: targetProvider?.name || "",
  });
}

async function recordUsage(input) {
  assertHandoffWritable();
  if (!usageState.loaded) {
    await loadUsageRecords();
  }
  const usage = extractUsage(input.responseBody, input.responseText);
  const requestModel = input.requestModel || extractRequestModel(input.requestBody);
  const responseModel = usage.model || requestModel || "unknown";
  const billingModel = normalizeBillingModel(responseModel);
  const billingMode = detectFastBillingMode(input.requestBody, input.responseBody, input.responseText)
    ? "fast"
    : "standard";
  const billingMultiplier = billingMode === "fast" ? FAST_MODE_MULTIPLIER : 1;
  const baseCost = estimateCost(billingModel, usage);
  const cost = roundMoney(baseCost * billingMultiplier);
  const record = {
    id: crypto.randomUUID(),
    groupId: input.groupId || "default",
    timestamp: new Date().toISOString(),
    providerId: input.provider?.id || null,
    providerName: input.provider?.name || "未选择",
    endpoint: input.endpoint || "",
    requestModel: requestModel || "",
    responseModel,
    billingModel,
    billingMode,
    billingMultiplier,
    statusCode: Number(input.statusCode || 0),
    latencyMs: Number(input.latencyMs || 0),
    isStreaming: Boolean(input.isStreaming),
    inputTokens: usage.inputTokens,
    ordinaryInputTokens: usage.ordinaryInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    totalTokens: usage.totalTokens,
    usageFormat: usage.usageFormat,
    usageObserved: usage.usageObserved,
    baseEstimatedCostUsd: baseCost,
    estimatedCostUsd: cost,
    error: input.error || "",
    failureClass: String(input.failureClass || ""),
    routeReason: String(input.routeReason || ""),
    usageCategory: String(input.usageCategory || ""),
    probeSource: String(input.probeSource || ""),
    targetProviderId: input.targetProviderId || null,
    targetProviderName: String(input.targetProviderName || ""),
    providerAttempts: normalizeProviderAttempts(input.providerAttempts),
    requestId: String(input.requestId || ""),
    upstreamRequestId: String(input.upstreamRequestId || ""),
  };
  usageState.records.push(record);
  usageQueries.invalidate();
  usageState.recordKeys.add(usageRecordKey(record));
  const writeTask = usageWriteQueue
    .catch(() => {})
    .then(async () => {
      if (HANDOFF_WORKER) {
        await requestHandoff("handoff_persist_usage", {
          workerId: HANDOFF_WORKER_ID || `${BUILD_INFO.releaseId}:${process.pid}`,
          dedupeKey: record.id,
          record,
        });
      } else {
        await appendUsageRecord(USAGE_PATH, record);
      }
      usageState.lastWriteAt = new Date().toISOString();
      usageState.lastWriteError = null;
    })
    .catch((error) => {
      if (HANDOFF_WORKER) {
        const spoolName = encodeURIComponent(HANDOFF_WORKER_ID || `pid-${process.pid}`);
        const spoolPath = path.join(DATA_DIR, "handoff-pending-usage", `${spoolName}.jsonl`);
        const spoolTask = handoffPendingUsageQueue
          .catch(() => {})
          .then(() => appendUsageRecord(spoolPath, { ...record, handoffPending: true }));
        handoffPendingUsageQueue = spoolTask.catch(() => {});
        return spoolTask.then(() => {
          usageState.lastWriteError = "监督器暂时不可用，记录已写入工作进程暂存队列";
          console.warn(`用量日志暂存（请求 ${record.requestId || record.id}）：${error.message}`);
        }).catch((spoolError) => {
          usageState.lastWriteError = spoolError.message;
          usageState.failedWrites += 1;
          console.error(`用量日志写入失败（请求 ${record.requestId || record.id}）：${spoolError.message}`);
        });
      }
      usageState.lastWriteError = error.message;
      usageState.failedWrites += 1;
      // 日志故障不能把已成功的上游响应变成重试，避免重复请求和计费。
      console.error(`用量日志写入失败（请求 ${record.requestId || record.id}）：${error.message}`);
    });
  usageWriteQueue = writeTask;
  await writeTask;
}

function buildBillingSummary(filters = {}) { return usageQueries.summaryAsync(filters); }

function normalizeUsageRecord(record, billing = config.billing) {
  return normalizeStoredUsageRecord(normalizeProviderTestUsageRecord(record), {
    estimateCost: (model, usage) => estimateCost(model, usage, billing),
    fastModeMultiplier: FAST_MODE_MULTIPLIER,
  });
}

function estimateCost(model, usage, billing = config.billing) {
  const pricing = getPricingForModel(model, billing);
  if (!pricing) return 0;
  const ordinaryInputTokens = Number.isFinite(Number(usage.ordinaryInputTokens))
    ? Number(usage.ordinaryInputTokens)
    : Math.max(
      0,
      Number(usage.inputTokens || 0) -
        Number(usage.cacheReadTokens || 0) -
        Number(usage.cacheCreationTokens || 0),
    );
  const inputCost = (ordinaryInputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;
  const cacheCreationCost =
    (usage.cacheCreationTokens / 1_000_000) * pricing.cacheCreationPerMillion;
  return roundMoney(inputCost + outputCost + cacheReadCost + cacheCreationCost);
}

function getPricingForModel(model, billing = config.billing) {
  const pricing = billing?.pricing || {};
  const billingModel = normalizeBillingModel(model);
  const exact = pricing[billingModel] || pricing[model];
  const wildcard = pricing["*"];
  return normalizePricing(exact || wildcard);
}

function updateBillingConfig(payload = {}, target = config) {
  const pricingPayload = payload.pricing || payload;
  const pricing = normalizePricingTable(defaultConfig.billing.pricing);
  for (const [model, value] of Object.entries(pricingPayload || {})) {
    const normalized = normalizePricing(value);
    if (normalized) {
      pricing[String(model || "").trim() || "*"] = normalized;
    }
  }
  target.billing = {
    currency: "USD",
    pricing,
  };
}

function sanitizeBillingConfig(billing = {}) {
  return {
    currency: "USD",
    pricing: {
      ...normalizePricingTable(defaultConfig.billing.pricing),
      ...normalizePricingTable(billing.pricing),
    },
  };
}

function normalizePricingTable(pricing = {}) {
  const result = {};
  for (const [model, value] of Object.entries(pricing || {})) {
    const normalized = normalizePricing(value);
    if (normalized) {
      result[model] = normalized;
    }
  }
  return result;
}

function normalizePricing(value) {
  if (!value || typeof value !== "object") return null;
  const next = {
    inputPerMillion: nonNegativeNumber(value.inputPerMillion ?? value.input, 0),
    outputPerMillion: nonNegativeNumber(value.outputPerMillion ?? value.output, 0),
    cacheReadPerMillion: nonNegativeNumber(value.cacheReadPerMillion ?? value.cacheRead, 0),
    cacheCreationPerMillion: nonNegativeNumber(
      value.cacheCreationPerMillion ?? value.cacheCreation,
      0,
    ),
  };
  return Object.values(next).some((item) => item > 0) ? next : null;
}

async function loadConfig() {
  const authority = HANDOFF_WORKER ? await requestHandoff("handoff_read_config", {}) : null;
  if (authority) committedConfigRevision = authority.revision;
  const parsed = authority ? authority.config : await configStore.load();
  if (parsed) {
    const normalized = normalizeConfig(parsed);
    const currentProviderRepaired = parsed.proxy?.currentProviderId !== normalized.proxy.currentProviderId;
    const providerMirrorRepaired = providerMirrorNeedsRepair(parsed, normalized);
    if (!handoffReadOnly && (currentProviderRepaired || providerMirrorRepaired || !Array.isArray(parsed.groups) || Number(parsed.version) < 2 || parsed.groups.some((group) => group.routingVersion !== 1))) {
      await saveConfig(normalized);
    }
    return normalized;
  }
  const initial = normalizeConfig(defaultConfig);
  if (!handoffReadOnly) await saveConfig(initial);
  return initial;
}

async function saveConfig(nextConfig, { operationId = null } = {}) {
  assertHandoffConfigWritable();
  if (HANDOFF_WORKER) {
    const committed = await requestHandoff("handoff_persist_config", {
      workerId: HANDOFF_WORKER_ID || `${BUILD_INFO.releaseId}:${process.pid}`,
      config: nextConfig,
      baseRevision: committedConfigRevision, operationId,
    });
    committedConfigRevision = committed.revision;
    return true;
  }
  await configStore.save(nextConfig);
  return true;
}

function normalizeConfig(input) {
  const next = structuredClone(defaultConfig);
  const proxyInput = input?.proxy && typeof input.proxy === "object" ? input.proxy : {};
  next.proxy = {
    ...next.proxy,
    ...proxyInput,
    ...normalizeStreamPolicy(proxyInput),
  };
  // 旧配置使用 10/3/1 的重试默认值；未显式配置新策略时迁移到 30/6/2。
  if (
    !Object.prototype.hasOwnProperty.call(proxyInput, "providerMaxAttempts") &&
    Number(proxyInput.maxAttempts) === 10 &&
    Number(proxyInput.preferredProviderMaxAttempts) === 3
  ) {
    next.proxy.maxAttempts = 30;
    next.proxy.preferredProviderMaxAttempts = 6;
    next.proxy.providerMaxAttempts = 2;
  }
  next.proxy.circuit = {
    ...defaultConfig.proxy.circuit,
    ...(input?.proxy?.circuit && typeof input.proxy.circuit === "object"
      ? input.proxy.circuit
      : {}),
  };
  next.proxy.maxAttempts = Math.min(30, positiveInt(next.proxy.maxAttempts, 30));
  next.proxy.preferredProviderMaxAttempts = positiveInt(
    next.proxy.preferredProviderMaxAttempts,
    6,
  );
  next.proxy.providerMaxAttempts = positiveInt(next.proxy.providerMaxAttempts, 2);
  next.providers = Array.isArray(input?.providers)
    ? input.providers.map(createProvider).sort(compareProviders)
    : [];
  next.groups = normalizeGroups(input?.groups, {
    providers: next.providers,
    listenPort: PUBLIC_LISTEN_PORT,
    listenHost: PUBLIC_LISTEN_HOST,
  });
  syncDefaultProviderMirrors(next);
  next.ui = {
    ...defaultConfig.ui,
    ...(input?.ui && typeof input.ui === "object" ? input.ui : {}),
    groupThemeEnabled: input?.ui?.groupThemeEnabled !== false,
    palette: normalizeUiPalette(
      input?.ui?.palette
        || input?.groups?.find((group) => ["ocean", "macaron", "oil", "forest", "sunset"].includes(group?.theme?.palette))?.theme?.palette,
      "ocean",
    ),
  };
  next.billing = {
    ...defaultConfig.billing,
    ...(input?.billing && typeof input.billing === "object" ? input.billing : {}),
    pricing: {
      ...normalizePricingTable(defaultConfig.billing.pricing),
      ...normalizePricingTable(input?.billing?.pricing),
    },
  };
  next.connectivityTest = {
    candidateModels: normalizeConnectivityCandidateModels(
      input?.connectivityTest?.candidateModels,
      defaultConfig.connectivityTest.candidateModels,
    ),
    periodicIntervalMs: normalizeConnectivityInterval(
      input?.connectivityTest?.periodicIntervalMs,
      defaultConfig.connectivityTest.periodicIntervalMs,
    ),
  };
  const currentProvider = next.providers.find((provider) => provider.id === next.proxy.currentProviderId);
  // 仅修复不存在或没有上游地址的手动供应商；关闭自动路由不等于禁止手动选择有效供应商。
  if (next.proxy.currentProviderId && (!currentProvider || !currentProvider.baseUrl)) {
    next.proxy.currentProviderId = repairManualProviderId(next.providers);
  }
  return next;
}

// 默认分组是主端口的真实路由来源；全局字段仅作旧客户端兼容镜像，必须与默认分组一致。
function syncDefaultProviderMirrors(nextConfig) {
  const defaultGroup = nextConfig.groups?.find((group) => group.id === "default");
  if (!defaultGroup) return;
  const refs = new Map((defaultGroup.providerRefs || []).map((ref) => [ref.providerId, ref]));
  for (const provider of nextConfig.providers || []) {
    const ref = refs.get(provider.id);
    if (!ref) continue;
    setProviderRoutingEnabled(provider, ref.enabled !== false);
    provider.sortIndex = positiveInt(ref.sortIndex, provider.sortIndex || 1);
  }
}

function providerMirrorNeedsRepair(rawConfig, normalizedConfig) {
  const rawProviders = new Map((rawConfig?.providers || []).map((provider) => [String(provider?.id || ""), provider]));
  return (normalizedConfig.providers || []).some((provider) => {
    const raw = rawProviders.get(provider.id);
    return !raw ||
      Boolean(raw.routingEnabled) !== Boolean(provider.routingEnabled) ||
      Boolean(raw.enabled) !== Boolean(provider.enabled) ||
      Boolean(raw.inFailoverQueue) !== Boolean(provider.inFailoverQueue) ||
      Number(raw.sortIndex || 0) !== Number(provider.sortIndex || 0);
  });
}

// 修复失效的手动供应商时，优先选择排序最高且仍参与自动路由的有效供应商。
// 只有在没有自动路由候选时才退回到任意有上游地址的供应商；显式选择的有效
// 但未参与自动路由供应商不会被这里改写。
function repairManualProviderId(providers = []) {
  const configured = providers.filter((provider) => provider.baseUrl);
  const routed = configured.filter((provider) => isProviderInAutoRouting(provider));
  return (routed[0] || configured[0])?.id || null;
}

function updateProxyConfig(payload, target = config) {
  Object.assign(target.proxy, normalizeStreamPolicy(payload, target.proxy));
  target.proxy.autoFailoverEnabled = Boolean(
    payload.autoFailoverEnabled ?? target.proxy.autoFailoverEnabled,
  );
  const currentProvider = target.providers.find((provider) => provider.id === target.proxy.currentProviderId);
  if (target.proxy.currentProviderId && (!currentProvider || !currentProvider.baseUrl)) {
    target.proxy.currentProviderId = repairManualProviderId(target.providers);
  }
  target.proxy.maxAttempts = Math.min(
    30,
    positiveInt(payload.maxAttempts, target.proxy.maxAttempts),
  );
  target.proxy.preferredProviderMaxAttempts = positiveInt(
    payload.preferredProviderMaxAttempts,
    target.proxy.preferredProviderMaxAttempts,
  );
  target.proxy.providerMaxAttempts = positiveInt(
    payload.providerMaxAttempts,
    target.proxy.providerMaxAttempts,
  );
  target.proxy.retryScheduleChunkSize = positiveInt(
    payload.retryScheduleChunkSize,
    target.proxy.retryScheduleChunkSize,
  );
  target.proxy.maxRetryElapsedMs = positiveInt(
    payload.maxRetryElapsedMs,
    target.proxy.maxRetryElapsedMs,
  );
  target.proxy.providerRetryDelayMs = positiveInt(
    payload.providerRetryDelayMs,
    target.proxy.providerRetryDelayMs,
  );
  target.proxy.providerRetryMaxDelayMs = positiveInt(
    payload.providerRetryMaxDelayMs,
    target.proxy.providerRetryMaxDelayMs,
  );
  target.proxy.providerRetryBudgetMs = positiveInt(
    payload.providerRetryBudgetMs,
    target.proxy.providerRetryBudgetMs,
  );
  target.proxy.preferredProviderRetryDelayMs = positiveInt(
    payload.preferredProviderRetryDelayMs,
    target.proxy.preferredProviderRetryDelayMs,
  );
  target.proxy.preferredProviderRetryMaxDelayMs = positiveInt(
    payload.preferredProviderRetryMaxDelayMs,
    target.proxy.preferredProviderRetryMaxDelayMs,
  );
  target.proxy.preferredProviderRetryBudgetMs = positiveInt(
    payload.preferredProviderRetryBudgetMs,
    target.proxy.preferredProviderRetryBudgetMs,
  );
  target.proxy.streamingFirstByteTimeoutMs = positiveInt(
    payload.streamingFirstByteTimeoutMs,
    target.proxy.streamingFirstByteTimeoutMs,
  );
  target.proxy.streamingIdleTimeoutMs = Math.max(
    0,
    Number(payload.streamingIdleTimeoutMs ?? target.proxy.streamingIdleTimeoutMs),
  );
  target.proxy.nonStreamingTimeoutMs = positiveInt(
    payload.nonStreamingTimeoutMs,
    target.proxy.nonStreamingTimeoutMs,
  );

  if (payload.circuit && typeof payload.circuit === "object") {
    target.proxy.circuit = {
      failureThreshold: positiveInt(
        payload.circuit.failureThreshold,
        target.proxy.circuit.failureThreshold,
      ),
      successThreshold: positiveInt(
        payload.circuit.successThreshold,
        target.proxy.circuit.successThreshold,
      ),
      openTimeoutMs: positiveInt(
        payload.circuit.openTimeoutMs,
        target.proxy.circuit.openTimeoutMs,
      ),
      errorRateThreshold: clampNumber(
        payload.circuit.errorRateThreshold,
        target.proxy.circuit.errorRateThreshold,
        0,
        1,
      ),
      minRequests: positiveInt(
        payload.circuit.minRequests,
        target.proxy.circuit.minRequests,
      ),
    };
  }
}

function updateUiConfig(payload, target = config) {
  if (!payload || typeof payload !== "object") return;
  if (Object.prototype.hasOwnProperty.call(payload, "groupThemeEnabled")) {
    target.ui.groupThemeEnabled = payload.groupThemeEnabled !== false;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "palette")) {
    const nextPalette = normalizeUiPalette(payload.palette, target.ui.palette || "ocean");
    if (nextPalette !== target.ui.palette) applyGlobalPalette(target.groups, nextPalette);
    target.ui.palette = nextPalette;
  }
}

function updateConnectivityTestConfig(payload, target = config) {
  if (!payload || typeof payload !== "object") return false;
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(payload, "candidateModels")) {
    const nextModels = normalizeConnectivityCandidateModels(
      payload.candidateModels,
      target.connectivityTest.candidateModels,
    );
    if (JSON.stringify(nextModels) !== JSON.stringify(target.connectivityTest.candidateModels)) {
      target.connectivityTest.candidateModels = nextModels;
      changed = true;
    }
  }
  if ("periodicIntervalMs" in payload || "periodicInterval" in payload) {
    const requestedInterval = Object.prototype.hasOwnProperty.call(payload, "periodicIntervalMs")
      ? payload.periodicIntervalMs
      : payload.periodicInterval;
    const nextInterval = normalizeConnectivityInterval(
      requestedInterval,
      target.connectivityTest.periodicIntervalMs,
    );
    if (nextInterval !== target.connectivityTest.periodicIntervalMs) {
      target.connectivityTest.periodicIntervalMs = nextInterval;
      changed = true;
    }
  }
  return changed;
}

function createProvider(payload = {}) {
  return createProviderConfig(payload, config.providers?.length + 1 || 1);
}

function updateGroup(group, payload = {}) {
  if (payload.name !== undefined) {
    group.name = String(payload.name || "未命名分组").trim() || "未命名分组";
  }
  if (payload.description !== undefined) group.description = String(payload.description || "").trim();
  if (payload.baseGroupId !== undefined) group.baseGroupId = String(payload.baseGroupId || "").trim() || null;
  if (group.id === "default") {
    group.listener = { host: PUBLIC_LISTEN_HOST, port: PUBLIC_LISTEN_PORT, enabled: true };
  } else if (payload.listener && typeof payload.listener === "object") {
    group.listener = {
      ...group.listener,
      ...payload.listener,
      port: normalizeGroupPort(payload.listener.port, group.listener.port),
      host: String(payload.listener.host || group.listener.host || "127.0.0.1").trim(),
      enabled: payload.listener.enabled !== false,
    };
  }
  if (Array.isArray(payload.providerRefs)) {
    const allowed = new Set(config.providers.map((provider) => provider.id));
    const seen = new Set();
    group.providerRefs = payload.providerRefs
      .map((item, index) => ({
        providerId: String(item?.providerId || "").trim(),
        enabled: item?.enabled !== false,
        sortIndex: positiveInt(item?.sortIndex, index + 1),
      }))
      .filter((item) => item.providerId && allowed.has(item.providerId) && !seen.has(item.providerId))
      .map((item) => {
        seen.add(item.providerId);
        return item;
      });
  }
  if (payload.routing && typeof payload.routing === "object") {
    group.routing = { ...group.routing, ...payload.routing };
  }
  if (payload.theme && typeof payload.theme === "object") {
    group.theme = normalizeTheme({ ...group.theme, ...payload.theme, colorIndex: group.theme.colorIndex });
  }
  group.updatedAt = new Date().toISOString();
}

function allocateGroupPort() {
  const used = new Set([
    PUBLIC_LISTEN_PORT,
    ...config.groups.map((group) => Number(group.listener?.port)).filter(Number.isInteger),
  ]);
  for (let port = PUBLIC_LISTEN_PORT + 1; port <= 65535; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

async function activateNewGroup(group, autoAllocate) {
  for (let attempt = 0; ; attempt += 1) {
    try { await groupListeners.apply(group); return; }
    catch (error) {
      if (!autoAllocate || error.code !== "EADDRINUSE" || attempt >= 100 || group.listener.port >= 65535) throw error;
      group.listener.port += 1;
    }
  }
}

async function mutateGroup(group, autoAllocate, change) {
  const previous = structuredClone(config.groups.find((item) => item.id === group.id) || null);
  const privatePortBefore = HANDOFF_GROUP_PORT_MAP[group.id];
  const needsPrepare = HANDOFF_WORKER && group.id !== "default" && (!previous || JSON.stringify(previous.listener) !== JSON.stringify(group.listener));
  const prepared = needsPrepare ? await requestHandoff("handoff_group_prepare", { group: { id: group.id, listener: group.listener }, autoAllocate }) : null;
  if (prepared) group.listener = prepared.listener;
  let persisted = false;
  try {
    await change(); persisted = true;
    if (prepared) await requestHandoff("handoff_group_commit", { transaction: prepared.transaction, privatePort: groupListeners.status(group.id).actualListener?.port || null });
    if (!group.listener.enabled) delete HANDOFF_GROUP_PORT_MAP[group.id];
    publishRuntimeStatusUpdate();
  } catch (error) {
    if (persisted || configTransactions.state().pendingConfirmation) throw error;
    if (privatePortBefore === undefined) delete HANDOFF_GROUP_PORT_MAP[group.id]; else HANDOFF_GROUP_PORT_MAP[group.id] = privatePortBefore;
    await groupListeners.apply(previous || { id: group.id, listener: { ...group.listener, enabled: false } });
    if (prepared) await requestHandoff("handoff_group_abort", { transaction: prepared.transaction });
    throw error;
  }
}

function normalizeGroupPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}


// 默认分组的供应商排序和自动路由开关保存在 providerRefs；全局供应商字段仅作为兼容镜像。
function syncDefaultProviderRef(provider, { routing = false, sortIndex = false } = {}, target = config) {
  const group = target.groups.find((item) => item.id === "default");
  if (!group || !provider) return;
  let ref = group.providerRefs.find((item) => item.providerId === provider.id);
  if (!ref) {
    ref = { providerId: provider.id, enabled: isProviderInAutoRouting(provider), sortIndex: provider.sortIndex || group.providerRefs.length + 1 };
    group.providerRefs.push(ref);
  }
  if (routing) ref.enabled = isProviderInAutoRouting(provider);
  if (sortIndex) ref.sortIndex = provider.sortIndex || ref.sortIndex;
  group.updatedAt = new Date().toISOString();
}

function syncDefaultProviderRefs() {
  for (const provider of config.providers) syncDefaultProviderRef(provider, { routing: true, sortIndex: true });
}

function providerIsAutoRoutedAnywhere(providerOrId) {
  const providerId = typeof providerOrId === "object" ? providerOrId?.id : providerOrId;
  return Boolean(providerId) && config.groups.some((group) =>
    providersForGroup(config, group.id).some((item) => item.id === providerId && isProviderInAutoRouting(item)),
  );
}

function syncProviderRecoveryProbe(provider) {
  if (!provider?.baseUrl || !providerIsAutoRoutedAnywhere(provider)) {
    recoveryProbeManager?.cancel(provider);
    return false;
  }
  return true;
}

// 分组开关可能通过整组保存或排序接口批量变化，统一同步所有供应商的恢复探测资格。
function syncAllProviderRecoveryProbes() {
  for (const provider of config.providers) syncProviderRecoveryProbe(provider);
}

function getGroupProviderRouting(provider, groupId) {
  const effective = providersForGroup(config, groupId).find((item) => item.id === provider.id);
  return { routingEnabled: effective?.routingEnabled || false, enabled: effective?.enabled || false, inFailoverQueue: effective?.inFailoverQueue || false, sortIndex: effective?.sortIndex || provider.sortIndex };
}

function buildGroupStatus(group) {
  const listenerState = groupListeners?.status(group.id) || { actualListener: null, listenerStatus: "not_listening", listenerError: "" };
  const { actualListener } = listenerState;
  const proxy = groupProxy(config, group.id);
  return {
    ...sanitizeGroup(group),
    ...(actualListener ? { listener: { ...actualListener, enabled: true } } : {}),
    ...listenerState,
    proxy,
    statistics: groupStatistics.snapshot(group.id),
    providerActivity: providerActivity.snapshot(group.id),
    activeRequests: requestLifecycle.stats({ groupId: group.id, idleTimeoutMs: proxy.streamingIdleTimeoutMs }),
  };
}

function sanitizeConfig(rawConfig, groupId = "default") {
  const effectiveGroupId = rawConfig.groups?.some((group) => group.id === groupId)
    ? groupId
    : "default";
  const effectiveProxy = groupProxy(rawConfig, effectiveGroupId);
  const proxy = {
    ...effectiveProxy,
    // 明确这是手动模式的选择，避免与最近一次真实业务供应商混淆。
    manualProviderId: effectiveProxy.currentProviderId || null,
  };
  return {
    ...rawConfig,
    ui: {
      groupThemeEnabled: rawConfig.ui?.groupThemeEnabled !== false,
      palette: rawConfig.ui?.palette || "ocean",
    },
    // 管理接口返回当前分组的有效开关和排序，避免把全局兼容字段误当成当前分组配置。
    providers: providersForGroup(rawConfig, effectiveGroupId).map(sanitizeProvider),
    groups: (rawConfig.groups || []).map(buildGroupStatus),
    proxy,
  };
}

const ROUTED_PROVIDER_IDS = {
  // Plus 由 CC Switch 官方代理负责 OAuth；Lite 只把请求转发到 15721。
  plus: "3e5bbfa0-51e3-449a-aa63-68ad39283bbb",
};

function selectProviders(requestModel = "", routeKey = "cct", routingContext = null, groupId = "default") {
  const stickyRouting = getGroupStickyRouting(groupId);
  const proxy = groupProxy(config, groupId);
  const configured = providersForGroup(config, groupId).filter((provider) => provider.baseUrl && (groupId === "default" || isProviderInAutoRouting(provider) || !proxy.autoFailoverEnabled && provider.id === proxy.currentProviderId));
  const routeCandidates = routeKey === "cct"
    ? getCctRouteCandidates(configured)
    : configured.filter((provider) => provider.id === ROUTED_PROVIDER_IDS[routeKey]);

  if (routeKey !== "cct") {
    return orderProvidersForModel(
      routeCandidates.filter((provider) => getBreaker(provider).isAvailable()),
      requestModel,
    );
  }

  if (!proxy.autoFailoverEnabled) {
    const current = routeCandidates.find(
      (provider) => provider.id === proxy.currentProviderId,
    );
    return current ? [current] : routeCandidates.slice(0, 1);
  }

  const candidates = routeCandidates
    .filter(isProviderInAutoRouting)
    .sort(compareProviders);
  const circuitAvailable = candidates.filter((provider) => getBreaker(provider).isAvailable());
  let modelAvailable = orderProvidersForModel(circuitAvailable, requestModel);
  // 显式 previous_response_id 必须优先回到产生该响应的供应商；普通请求继续服从会话粘滞。
  if (routingContext?.previousProviderId) {
    // previous_response_id 是供应商上下文的直接证据，即使该供应商的模型支持
    // 缓存暂时过期/误记为 unsupported，也要保留它作为兼容回退目标。
    const contextProviderIds = new Set([
      routingContext.previousProviderId,
      ...(routingContext.previousFallbackProviderIds || []),
    ]);
    const contextProviders = circuitAvailable.filter((provider) => contextProviderIds.has(provider.id));
    const regularProviders = modelAvailable.filter((provider) => !contextProviderIds.has(provider.id));
    modelAvailable = [...contextProviders, ...regularProviders];
    const previousOrdered = moveProviderIdsToFront(
      modelAvailable,
      [routingContext.previousProviderId, ...(routingContext.previousFallbackProviderIds || [])],
    );
    return previousOrdered;
  }
  const stickyProviderId = stickyRouting.get(routingContext?.key)?.providerId || "";
  return preferConfirmedCheaperProvider(
    stickyRouting.orderProviders(routingContext?.key, modelAvailable),
    stickyProviderId,
    requestModel,
  );
}

/**
 * 价格优先覆盖旧粘滞：只有同模型已经连续恢复确认的更便宜供应商才可越过粘滞。
 * 当前请求的供应商列表在请求开始时固定，因此不会中途改写正在传输的 SSE。
 */
function preferConfirmedCheaperProvider(providers, stickyProviderId, requestModel) {
  const list = Array.isArray(providers) ? providers.slice() : [];
  const sticky = list.find((provider) => provider.id === stickyProviderId);
  if (!sticky || !requestModel) return list;
  const cheaperConfirmed = list.find((provider) =>
    provider.id !== sticky.id &&
    isHigherPriority(provider, sticky) &&
    isRecoveryConfirmed(provider, requestModel),
  );
  return cheaperConfirmed ? moveProviderToFront(list, cheaperConfirmed.id) : list;
}


function moveProviderToFront(providers, providerId) {
  const list = Array.isArray(providers) ? providers.slice() : [];
  const index = list.findIndex((provider) => provider.id === providerId);
  if (index <= 0) return list;
  const [provider] = list.splice(index, 1);
  return [provider, ...list];
}

function moveProviderIdsToFront(providers, providerIds) {
  const list = Array.isArray(providers) ? providers.slice() : [];
  const ids = uniqueStrings(providerIds);
  const selected = [];
  for (const id of ids) {
    const index = list.findIndex((provider) => provider.id === id);
    if (index < 0) continue;
    selected.push(list[index]);
    list.splice(index, 1);
  }
  return [...selected, ...list];
}

function describeProviderAvailability(requestModel = "", routeKey = "cct", groupId = "default") {
  const proxy = groupProxy(config, groupId);
  const configured = providersForGroup(config, groupId).filter((provider) => provider.baseUrl && (groupId === "default" || isProviderInAutoRouting(provider) || !proxy.autoFailoverEnabled && provider.id === proxy.currentProviderId));
  if (configured.length === 0) {
    return {
      type: "no_configured_provider",
      message: "本分组没有配置完整且参与路由的供应商，请先在网页中配置本组供应商。",
    };
  }
  const routeCandidates = routeKey === "cct"
    ? getCctRouteCandidates(configured)
    : configured.filter((provider) => provider.id === ROUTED_PROVIDER_IDS[routeKey]);
  if (routeCandidates.length === 0) {
    return {
      type: "no_route_provider",
      message: `路由 ${routeKey} 没有配置对应供应商。`,
    };
  }
  if (routeKey !== "cct") {
    if (orderProvidersForModel(
      routeCandidates.filter((provider) => getBreaker(provider).isAvailable()),
      requestModel,
    ).length === 0) {
      return {
        type: "route_provider_unavailable",
        message: `路由 ${routeKey} 当前不可用，请检查该供应商配置或认证状态。`,
      };
    }
    return {
      type: "no_available_provider",
      message: `路由 ${routeKey} 当前不支持模型 ${requestModel}。`,
    };
  }
  if (!proxy.autoFailoverEnabled) {
    return {
      type: "no_selected_provider",
      message: "单供应商模式下没有可用的当前供应商，请重新选择供应商。",
    };
  }
  const candidates = routeCandidates.filter(isProviderInAutoRouting);
  if (candidates.length === 0) {
    return {
      type: "no_auto_routing_provider",
      message: "没有参与自动路由且配置完整的供应商，请先在网页中开启“参与自动路由”。",
    };
  }
  const circuitAvailable = candidates.filter((provider) => getBreaker(provider).isAvailable());
  if (circuitAvailable.length === 0) {
    return {
      type: "all_provider_circuits_unavailable",
      message: "所有候选供应商当前都处于熔断或半开探测占用状态，请稍后重试。",
    };
  }
  if (requestModel && orderProvidersForModel(circuitAvailable, requestModel).length === 0) {
    return {
      type: "model_temporarily_unavailable",
      message: `所有候选供应商暂时都不支持模型 ${requestModel}，缓存到期后会自动重新尝试。`,
    };
  }
  return {
    type: "no_available_provider",
    message: "没有可用供应商，请检查自动路由供应商和模型支持状态。",
  };
}

function getCctRouteCandidates(configured) {
  // 默认 /v1 路由只服从供应商配置中的自动路由开关和 sortIndex。
  // cx1～cx5 与其他供应商一样，直接依据自动路由开关和 sortIndex 参与候选排序。
  return configured.sort(compareProviders);
}

function getBreaker(provider) {
  if (!breakers.has(provider.id)) {
    breakers.set(provider.id, new CircuitBreaker(provider.id, config.proxy.circuit));
  }
  const breaker = breakers.get(provider.id);
  breaker.updateConfig(config.proxy.circuit);
  return breaker;
}

function recordDeferredCircuitFailures(providerStates = []) {
  for (const state of providerStates) {
    // 状态在本请求结束时才进入断路器，避免请求内有限重试过早熔断。
    if (state.circuitFailureObserved && !state.succeeded && !state.circuitFailureRecorded) {
      getBreaker(state.provider).recordFailure(false);
      state.circuitFailureRecorded = true;
    }
  }
}

async function maybeSaveCurrentProvider(providerId, forceSave = false, groupId = "default") {
  return commitConfig((draft) => {
    const proxy = groupProxy(draft, groupId);
    if (!proxy.autoFailoverEnabled && proxy.currentProviderId !== providerId) {
      if (groupId === "default") draft.proxy.currentProviderId = providerId;
      else draft.groups.find((group) => group.id === groupId).routing.currentProviderId = providerId;
    }
  });
}

async function testProvider(provider, modelsOverride, options = {}) {
  const startedAt = Date.now();
  const attempts = [];
  const models = modelsOverride ?? getProviderTestModels(provider);
  for (const requestModel of models) {
    const result = await testProviderWithModel(provider, requestModel, startedAt, options);
    attempts.push({
      model: requestModel,
      ok: result.ok,
      status: result.status,
      failureClass: result.failureClass || "",
      message: result.message,
      latencyMs: result.latencyMs,
    });
    if (result.skipped) {
      return {
        ...result,
        attempts,
        supportedModels: provider.modelSupport?.supportedModels || [],
        unsupportedModels: provider.modelSupport?.unsupportedModels || [],
      };
    }
    if (options.persist !== false) {
      await commitConfig((draft) => {
        const target = draft.providers.find((item) => item.id === provider.id);
        if (target) rememberProviderModelTest(target, requestModel, result);
      });
      provider = findProvider(provider.id) || provider;
    }
    if (result.ok) {
      return {
        ...result,
        attempts,
        supportedModels: provider.modelSupport?.supportedModels || [],
        unsupportedModels: provider.modelSupport?.unsupportedModels || [],
      };
    }
    if (!shouldTryNextProviderTestModel(result, attempts.length, models.length)) {
      return {
        ...result,
        attempts,
        supportedModels: provider.modelSupport?.supportedModels || [],
        unsupportedModels: provider.modelSupport?.unsupportedModels || [],
      };
    }
  }
  return {
    ok: false,
    status: attempts.at(-1)?.status || 0,
    latencyMs: Date.now() - startedAt,
    model: attempts.at(-1)?.model || PROVIDER_TEST_MODEL,
    message: `所有测试模型均不可用：${attempts.map((item) => `${item.model}(${item.status || "无状态"})`).join(" -> ")}`,
    attempts,
    supportedModels: provider.modelSupport?.supportedModels || [],
    unsupportedModels: provider.modelSupport?.unsupportedModels || [],
  };
}

function getRecoveryProbeModel(provider) {
  const records = usageState.records
    .filter((record) => !isProviderTestUsageRecord(record))
    .slice(-200);
  const counts = new Map();
  records.forEach((record, index) => {
    const model = String(record.requestModel || record.responseModel || "").trim();
    if (
      !model ||
      model.toLowerCase() === "unknown" ||
      getModelAvailability(provider, model).state === "unsupported"
    ) return;
    const current = counts.get(model) || { count: 0, lastIndex: -1 };
    counts.set(model, { count: current.count + 1, lastIndex: index });
  });
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].lastIndex - a[1].lastIndex)
    .map(([model]) => model);
  return ranked[0] || getProviderTestModels(provider)[0] || PROVIDER_TEST_MODEL;
}

function summarizeHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (
      ["authorization", "proxy-authorization", "cookie", "set-cookie"].includes(key.toLowerCase()) ||
      /key|token|secret|password/i.test(key)
    ) {
      continue;
    }
    result[key] = Array.isArray(value) ? value[0] : String(value || "").slice(0, 200);
  }
  return result;
}

async function run413Diagnostic(snapshot) {
  const provider = snapshot.provider;
  const body = Buffer.from(snapshot.body || []);
  const requestHash = crypto.createHash("sha256").update(body).digest("hex");
  const base = {
    providerId: snapshot.providerId,
    providerName: snapshot.providerName,
    requestModel: snapshot.requestModel,
    requestBytes: body.length,
    requestSha256: requestHash,
    endpoint: snapshot.pathname,
    headers: summarizeHeaders(snapshot.headers),
    steps: [],
  };
  const requestBody = rectifyRequestBody(provider, body);
  const targetUrl = joinUpstreamUrl(provider.baseUrl, snapshot.pathname, snapshot.search, provider);
  const originalSessionHeaders = provider.authMode === "client_session"
    ? Object.fromEntries((provider.sessionHeaders || [])
      .map((name) => {
        const value = snapshot.headers?.[name] || snapshot.headers?.[name.toLowerCase()];
        return [name, Array.isArray(value) ? value[0] : value];
      })
      .filter(([, value]) => value))
    : null;
  const headers = await buildProviderOnlyHeaders(
    provider,
    clientSessionContexts.get(provider) || originalSessionHeaders,
  );
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");

  for (let index = 0; index < 2; index += 1) {
    const startedAt = Date.now();
    let status = 0;
    let responseBytes = 0;
    let error = "";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);
      const finishActivity = providerActivity.start(provider, "diagnostic", snapshot.groupId || "default");
      try {
        const response = await fetch(targetUrl, {
          method: snapshot.method || "POST",
          headers,
          body: shouldSendBody(snapshot.method || "POST") ? requestBody : undefined,
          signal: controller.signal,
          dispatcher: getProviderDispatcher(provider),
        });
        status = response.status;
        responseBytes = Buffer.byteLength(await response.text());
      } finally {
        clearTimeout(timer);
        finishActivity();
      }
    } catch (caught) {
      error = redactDiagnosticText(truncateText(formatFetchError(caught), 400), provider);
    }
    base.steps.push({
      type: "original_payload_retry",
      attempt: index + 1,
      status,
      responseBytes,
      latencyMs: Date.now() - startedAt,
      error,
    });
  }

  const model = String(snapshot.requestModel || getRecoveryProbeModel(provider));
  for (let index = 0; index < 2; index += 1) {
    const ccokStartedAt = Date.now();
    const ccok = await testProvider(provider, [model], { recordUsage: false, persist: false, groupId: snapshot.groupId || "default" });
    base.steps.push({
      type: "ccok",
      attempt: index + 1,
      model,
      ok: Boolean(ccok.ok),
      status: Number(ccok.status || 0),
      latencyMs: Date.now() - ccokStartedAt,
      message: redactDiagnosticText(truncateText(ccok.message, 400), provider),
    });
  }
  return base;
}

function redactDiagnosticText(value, provider = null) {
  let text = String(value || "");
  const apiKey = String(provider?.apiKey || "").trim();
  if (apiKey) text = text.split(apiKey).join("[已脱敏]");
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已脱敏]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[已脱敏]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[已脱敏]");
}

// CCOK 探测只改变路由健康信息：不伪装为当前业务供应商，也不会自动启用未加入队列的供应商。
async function applyProviderTestRoutingResult(provider, result, groupId = "default") {
  const routingEnabled = getGroupProviderRouting(provider, groupId).routingEnabled;
  const breaker = getBreaker(provider);

  if (result.authSourceUnavailable) {
    clearConfirmedRecovery(provider, result.model);
    return {
      ...result,
      routingEffect: "awaiting_oauth_file",
      routingMessage: "OAuth 认证文件暂时不可用，等待 CC Switch 完成会话同步后自动重读",
      circuit: breaker.stats(),
    };
  }

  if (result.skipped) {
    clearConfirmedRecovery(provider, result.model);
    return {
      ...result,
      routingEffect: "awaiting_session",
      routingMessage: result.sessionExpired
        ? "客户端会话已失效，等待下一次真实请求刷新"
        : "等待真实客户端请求提供会话上下文",
      circuit: breaker.stats(),
    };
  }

  if (result.ok) {
    markConfirmedRecovery(provider, result.model);
    recoveryProbeManager?.cancel(provider);
    breaker.recordProbeSuccess();
    const stickyMigrations = migrateStickyToRecoveredProvider(provider, result.model);
    if (HANDOFF_WORKER) await flushResponseContexts();
    publishRuntimeStatusUpdate();
    return {
      ...result,
      stickyMigrations,
      routingEffect: routingEnabled ? "recovered" : "verified_only",
      routingMessage: routingEnabled
        ? "检测通过，已恢复参与自动路由"
        : "检测通过；该供应商未参与自动路由",
      circuit: breaker.stats(),
    };
  }

  if (isProviderTestModelUnsupportedOnly(result)) {
    clearConfirmedRecovery(provider, result.model);
    return {
      ...result,
      routingEffect: "model_limited",
      routingMessage: "测试模型不支持，已仅更新模型可用性，不影响供应商整体路由",
      circuit: breaker.stats(),
    };
  }

  if (!routingEnabled) {
    return {
      ...result,
      routingEffect: "not_in_routing",
      routingMessage: "检测失败；该供应商未参与自动路由",
      circuit: breaker.stats(),
    };
  }

  clearConfirmedRecovery(provider, result.model);
  breaker.recordProbeFailure();
  publishRuntimeStatusUpdate();
  return {
    ...result,
    routingEffect: "temporarily_skipped",
    routingMessage: "检测失败，后续自动路由将暂时跳过该供应商",
    circuit: breaker.stats(),
  };
}

function isProviderTestModelUnsupportedOnly(result) {
  const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
  if (attempts.length > 0) {
    return attempts.every((attempt) => !attempt.ok && isUnsupportedModelResult(attempt));
  }
  return isUnsupportedModelResult(result);
}

async function runConnectivityTestCycle(reason, groupId) {
  const startedAt = Date.now();
  const targets = connectivityTargets(config, groupId);
  if (targets.length === 0) {
    return {
      ok: false,
      reason,
      message: "没有参与自动路由且配置完整的供应商",
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      results: [],
    };
  }

  const results = await Promise.all(targets.map(({ provider, groupId, groupIds }, index) => new Promise((resolve) => {
    setTimeout(async () => {
      try {
        const actualProvider = findProvider(provider.id) || provider;
        const result = await testProvider(actualProvider, undefined, { probeSource: reason, groupId });
        const routingResult = await applyProviderTestRoutingResult(actualProvider, result, groupId);
        resolve({
          providerId: provider.id,
          providerName: provider.name,
          groupIds,
          ok: Boolean(routingResult.ok),
          status: routingResult.status,
          model: routingResult.model,
          message: routingResult.message,
          latencyMs: routingResult.latencyMs,
          routingEffect: routingResult.routingEffect,
          routingMessage: routingResult.routingMessage,
        });
      } catch (error) {
        resolve({
          providerId: provider.id,
          providerName: provider.name,
          ok: false,
          status: error?.status || 0,
          message: error?.message || String(error),
          latencyMs: Date.now() - startedAt,
        });
      }
    }, index * 3000);
  })));

  return {
    ok: results.every((result) => result.ok),
    reason,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    results,
  };
}

async function testProviderWithModel(provider, requestModel, startedAt, options = {}) {
  const sessionContext = clientSessionContexts.get(provider);
  if (provider.authMode === "client_session" && !sessionContext) {
    return {
      ok: false,
      skipped: true,
      status: 0,
      latencyMs: Date.now() - startedAt,
      model: requestModel,
      message: "等待真实客户端请求提供会话上下文",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);
  const isCodexSessionProbe = ["client_session", "oauth_file"].includes(provider.authMode);
  const probeRequest = {
    model: requestModel,
    input: isCodexSessionProbe
      ? [{
        role: "user",
        content: [{
          type: "input_text",
          text: `请只回复 ${PROVIDER_TEST_EXPECTED_TEXT}，不要输出其他内容。`,
        }],
      }]
      : `请只回复 ${PROVIDER_TEST_EXPECTED_TEXT}，不要输出其他内容。`,
    stream: isCodexSessionProbe,
  };
  if (isCodexSessionProbe) {
    Object.assign(probeRequest, {
      store: false,
      include: ["reasoning.encrypted_content"],
      instructions: "",
      tools: [],
      parallel_tool_calls: false,
    });
  } else {
    probeRequest.max_output_tokens = 16;
  }
  const requestBody = rectifyRequestBody(
    provider,
    Buffer.from(JSON.stringify(probeRequest)),
  );
  let finishActivity;
  try {
    const url = joinUpstreamUrl(provider.baseUrl, "/v1/responses", "", provider);
    const headers = await buildProviderOnlyHeaders(provider, sessionContext);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    finishActivity = providerActivity.start(provider, "health_check", options.groupId || "default");
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal,
      dispatcher: getProviderDispatcher(provider),
    });
    const latencyMs = Date.now() - startedAt;
    const responseText = await response.text();
    finishActivity();
    const responseBody = Buffer.from(responseText);
    if (!response.ok) {
      const message = safeTextFromBuffer(responseBody) || `HTTP ${response.status}`;
      const authSourceUnavailable = provider.authMode === "oauth_file" && response.status === 401;
      await recordProviderTestUsage(provider, {
        endpoint: "/v1/responses#provider-test",
        requestModel,
        statusCode: response.status,
        latencyMs,
        isStreaming: isCodexSessionProbe,
        responseBody,
        responseText,
        requestBody,
        error: message,
        failureClass: authSourceUnavailable
          ? "oauth_file_unavailable"
          : classifyProxyFailure({ status: response.status, message }),
      }, options);
      if (provider.authMode === "client_session" && response.status === 401) {
        clientSessionContexts.clear(provider);
        return {
          ok: false,
          skipped: true,
          sessionExpired: true,
          status: response.status,
          latencyMs,
          model: requestModel,
          message,
        };
      }
      if (provider.authMode === "oauth_file" && response.status === 401) {
        return {
          ok: false,
          skipped: true,
          authSourceUnavailable: true,
          status: response.status,
          latencyMs,
          model: requestModel,
          message,
        };
      }
      return {
        ok: false,
        status: response.status,
        latencyMs,
        model: requestModel,
        message,
      };
    }

    const answer = extractProviderTestAnswer(responseBody);
    const observedUsage = extractUsage(responseBody, responseText);
    const responseModel = String(observedUsage.model || "").trim();
    // 供应商可通过 modelMap 将逻辑模型映射到实际上游模型；校验时比较改写后的
    // 上游模型，避免把显式配置的映射误判为“请求 astra、返回 luna”。
    const upstreamRequestModel = extractRequestModel(requestBody) || requestModel;
    const modelMismatch = Boolean(
      responseModel && upstreamRequestModel && responseModel !== upstreamRequestModel,
    );
    const answerOk = isProviderTestAnswerOk(answer);
    const ok = answerOk && !modelMismatch;
    const message = modelMismatch
      ? `模型响应模型不匹配：请求 ${requestModel}，实际 ${responseModel}`
      : ok
        ? `模型回答正常: ${truncateText(answer, 80)}`
        : `模型回答不符合预期: ${truncateText(answer || safeTextFromBuffer(responseBody), 200) || "空响应"}`;
    await recordProviderTestUsage(provider, {
      endpoint: "/v1/responses#provider-test",
      requestModel,
      statusCode: response.status,
      latencyMs,
      isStreaming: isCodexSessionProbe,
      responseBody,
      responseText,
      requestBody,
      error: ok ? "" : message,
      failureClass: modelMismatch
        ? "model_unsupported"
        : ok
          ? ""
          : "provider_test_mismatch",
    }, options);
    return {
      ok,
      status: response.status,
      latencyMs,
      model: requestModel,
      responseModel: responseModel || requestModel,
      failureClass: modelMismatch ? "model_unsupported" : ok ? "" : "provider_test_mismatch",
      answer: truncateText(answer, 200),
      expected: PROVIDER_TEST_EXPECTED_TEXT,
      message,
    };
  } catch (error) {
    const message = formatFetchError(error);
    const authSourceUnavailable = error?.failureClass === "oauth_file_unavailable";
    await recordProviderTestUsage(provider, {
      endpoint: "/v1/responses#provider-test",
      requestModel,
      statusCode: authSourceUnavailable ? Number(error.status || 503) : 0,
      latencyMs: Date.now() - startedAt,
      isStreaming: isCodexSessionProbe,
      requestBody,
      error: message,
      failureClass: authSourceUnavailable
        ? error.failureClass
        : classifyProxyFailure({ status: 0, message }),
    }, options);
    return {
      ok: false,
      skipped: authSourceUnavailable,
      authSourceUnavailable,
      status: authSourceUnavailable ? Number(error.status || 503) : 0,
      latencyMs: Date.now() - startedAt,
      model: requestModel,
      message,
    };
  } finally {
    clearTimeout(timer);
    finishActivity?.();
  }
}

function getProviderTestModels(provider, nowMs = Date.now()) {
  const support = normalizeModelSupport(provider.modelSupport, nowMs);
  const candidates = config.connectivityTest?.candidateModels?.length
    ? config.connectivityTest.candidateModels
    : PROVIDER_TEST_MODELS;
  const preferredModel = support.preferredTestModel && !support.unsupportedModels.includes(support.preferredTestModel)
    ? support.preferredTestModel
    : "";
  const preferredIndex = candidates.indexOf(preferredModel);
  const remainingCandidates = preferredIndex >= 0
    ? [...candidates.slice(preferredIndex + 1), ...candidates.slice(0, preferredIndex)]
    : candidates;
  return uniqueStrings([
    preferredModel,
    ...remainingCandidates.filter((model) => !support.unsupportedModels.includes(model)),
  ]);
}

function rememberProviderModelTest(provider, model, result) {
  let support = normalizeModelSupport(provider.modelSupport);
  if (result.ok) {
    rememberProviderModelEvidence(
      provider,
      model,
      "supported",
      "provider_test",
      "provider_test_succeeded",
    );
    support = normalizeModelSupport(provider.modelSupport);
    support.preferredTestModel = model;
  } else if (isUnsupportedModelResult(result)) {
    rememberProviderModelEvidence(
      provider,
      model,
      "unsupported",
      "provider_test",
      "model_unsupported",
    );
    support = normalizeModelSupport(provider.modelSupport);
    if (support.preferredTestModel === model) {
      support.preferredTestModel = support.supportedModels[0] || "";
    }
  }
  support.lastTestedAt = new Date().toISOString();
  provider.modelSupport = support;
}

function isUnsupportedModelResult(result) {
  return result?.failureClass === "model_unsupported" ||
    isUnsupportedModelText(result?.message);
}

function shouldTryNextProviderTestModel(result, attemptCount, totalAttempts) {
  if (attemptCount >= totalAttempts) return false;
  if (isUnsupportedModelResult(result)) return true;
  const text = String(result?.message || "").toLowerCase();
  const status = Number(result?.status || 0);
  return status === 0 ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    (status === 200 && (text.includes("不符合预期") || text.includes("空响应")));
}

function extractProviderTestAnswer(responseBody) {
  const text = Buffer.from(responseBody || []).toString("utf8");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return extractSseText(text);
  }
  return extractTextFromPayload(payload).trim();
}

function extractSseText(text) {
  const parts = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      parts.push(extractTextFromPayload(JSON.parse(data)));
    } catch {
      // 忽略不能解析的 SSE 数据行，继续尝试后续有效事件。
    }
  }
  return parts.filter(Boolean).join("").trim();
}

function extractTextFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string") return payload.output_text;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.delta === "string") return payload.delta;
  if (Array.isArray(payload.output)) {
    return payload.output.map(extractTextFromPayload).filter(Boolean).join("");
  }
  if (Array.isArray(payload.content)) {
    return payload.content.map(extractTextFromPayload).filter(Boolean).join("");
  }
  if (payload.message) return extractTextFromPayload(payload.message);
  if (payload.delta) return extractTextFromPayload(payload.delta);
  if (Array.isArray(payload.choices)) {
    return payload.choices.map(extractTextFromPayload).filter(Boolean).join("");
  }
  if (payload.message?.content) return extractTextFromPayload(payload.message.content);
  if (payload.choices?.[0]?.message?.content) {
    return extractTextFromPayload(payload.choices[0].message.content);
  }
  if (payload.response) return extractTextFromPayload(payload.response);
  return "";
}

function isProviderTestAnswerOk(answer) {
  const normalized = String(answer || "").toUpperCase().replace(/\s+/g, "");
  return normalized.includes(PROVIDER_TEST_EXPECTED_TEXT);
}

function safeTextFromBuffer(buffer) {
  try {
    return Buffer.from(buffer || []).toString("utf8").slice(0, 4000);
  } catch {
    return "";
  }
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function findProvider(providerId) {
  if (!providerId) return null;
  return config.providers.find((provider) => provider.id === providerId) || null;
}

function sortProviders(target = config) {
  sortProviderList(target.providers);
}

async function waitForRetry(delayMs, signal) {
  try {
    await delay(delayMs, undefined, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function roundNumber(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function bytesToMb(value) {
  return roundNumber(Number(value || 0) / 1024 / 1024, 1);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

export {
  applyManualModelSupport,
  calculateActualCost,
  calculateUsageCost,
  classifyProxyFailure,
  createShutdownController,
  createConnectivityScheduler,
  createSseInspector,
  detectKnownProviderCompatibilityError,
  getModelAvailability,
  getProviderTestModels,
  fitEffectivePrices,
  isUnsupportedModelResult,
  normalizeConnectivityCandidateModels,
  normalizeRawUsage,
  normalizeModelSupport,
  normalizeConnectivityInterval,
  orderProvidersForModel,
  providerRetryDelay,
  preferredProviderRetryDelay,
  pipeReadableStream,
  probeSseStream,
  rememberProviderModelEvidence,
  shouldTryNextProviderTestModel,
  shouldInvalidateSticky,
};
