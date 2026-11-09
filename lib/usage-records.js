/**
 * 请求用量解析与记录归一化模块。
 * 负责提取 Token、整理供应商尝试和 SSE 诊断，不访问配置或持久化文件。
 */

import { normalizeRawUsage } from "./price-calculation.js";

const GPT_55_BILLING_MODEL = "gpt-5.5";
const DEFAULT_FAST_MODE_MULTIPLIER = 2.5;
// 旧版本曾把探测记录写成这个伪供应商；只用于读取旧日志时恢复真实供应商。
const LEGACY_CCOK_PROBE_PROVIDER_ID = "__ccok_probe__";

export function isProviderTestUsageRecord(record) {
  return String(record?.endpoint || "").includes("#provider-test") ||
    String(record?.usageCategory || "") === "ccok_probe";
}

// 语义更明确的别名：CCOK 是流量类别，不是供应商实体。
export function isCcokProbeUsageRecord(record) {
  return isProviderTestUsageRecord(record);
}

// CCOK 不是供应商，只是流量类别；历史伪供应商记录读取时恢复到真实目标供应商。
export function normalizeProviderTestUsageRecord(record) {
  if (!isProviderTestUsageRecord(record)) return record;
  const isLegacyPseudoProvider = record?.providerId === LEGACY_CCOK_PROBE_PROVIDER_ID;
  const targetProviderId = String(
    record?.targetProviderId ||
      (isLegacyPseudoProvider ? "" : record?.providerId) ||
      "",
  ).trim() || null;
  const targetProviderName = String(
    record?.targetProviderName ||
      (isLegacyPseudoProvider ? "" : record?.providerName) ||
      "",
  ).trim();
  return {
    ...record,
    providerId: targetProviderId,
    providerName: targetProviderName || (targetProviderId || "未知供应商"),
    usageCategory: "ccok_probe",
    targetProviderId,
    targetProviderName: targetProviderName || (targetProviderId || ""),
  };
}

export function normalizeUsageRecord(record, options = {}) {
  const sourceRecord = normalizeProviderTestUsageRecord(record) || {};
  const estimateCost = typeof options.estimateCost === "function"
    ? options.estimateCost
    : () => 0;
  const fastModeMultiplier = Number(options.fastModeMultiplier || DEFAULT_FAST_MODE_MULTIPLIER);
  const responseModel = sourceRecord.responseModel || sourceRecord.requestModel || "unknown";
  const billingModel = sourceRecord.billingModel || normalizeBillingModel(responseModel);
  const billingMode = sourceRecord.billingMode || (Number(sourceRecord.billingMultiplier || 1) > 1 ? "fast" : "standard");
  const billingMultiplier = billingMode === "fast"
    ? Number(sourceRecord.billingMultiplier || fastModeMultiplier)
    : 1;
  const usage = {
    inputTokens: Number(sourceRecord.inputTokens || 0),
    ordinaryInputTokens: Number(
      sourceRecord.ordinaryInputTokens ??
        Math.max(
          0,
          Number(sourceRecord.inputTokens || 0) -
            Number(sourceRecord.cacheReadTokens || 0) -
            Number(sourceRecord.cacheCreationTokens || 0),
        ),
    ),
    outputTokens: Number(sourceRecord.outputTokens || 0),
    cacheReadTokens: Number(sourceRecord.cacheReadTokens || 0),
    cacheCreationTokens: Number(sourceRecord.cacheCreationTokens || 0),
  };
  const baseEstimatedCostUsd = estimateCost(billingModel, usage);
  return {
    ...sourceRecord,
    groupId: String(sourceRecord.groupId || "default"),
    responseModel,
    billingModel,
    billingMode,
    billingMultiplier,
    failureClass: String(sourceRecord.failureClass || ""),
    routeReason: String(sourceRecord.routeReason || ""),
    ordinaryInputTokens: usage.ordinaryInputTokens,
    usageFormat: String(sourceRecord.usageFormat || "unknown"),
    usageObserved: Boolean(
      sourceRecord.usageObserved ??
        (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheCreationTokens),
    ),
    baseEstimatedCostUsd,
    estimatedCostUsd: roundMoney(baseEstimatedCostUsd * billingMultiplier),
    providerAttempts: normalizeProviderAttempts(sourceRecord.providerAttempts),
  };
}

export function appendProviderAttempt(attempts, provider, details = {}) {
  if (!Array.isArray(attempts)) return;
  const startedAtMs = Number(details.startedAtMs || Date.now());
  attempts.push({
    sequence: attempts.length + 1,
    providerId: provider?.id || null,
    providerName: provider?.name || "未选择",
    startedAt: new Date(startedAtMs).toISOString(),
    latencyMs: Math.max(0, Date.now() - startedAtMs),
    statusCode: Number(details.statusCode || 0),
    outcome: ["success", "failure", "skipped"].includes(details.outcome)
      ? details.outcome
      : "failure",
    retryable: Boolean(details.retryable),
    affectsCircuit: details.affectsCircuit !== false,
    failureClass: details.outcome === "success"
      ? ""
      : String(details.failureClass || "unknown"),
    error: truncateText(String(details.error || ""), 2000),
    providerAttempt: positiveInt(details.providerAttempt, 1),
    retryDelayMs: Math.max(0, Number(details.retryDelayMs || 0)),
    usage: normalizeAttemptUsage(details.usage),
    streamDiagnostics: normalizeStreamDiagnostics(details.streamDiagnostics),
    circuitStateBefore: String(details.circuitStateBefore || "unknown"),
    usedHalfOpenPermit: Boolean(details.usedHalfOpenPermit),
  });
}

export function normalizeProviderAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.map((attempt, index) => ({
    sequence: positiveInt(attempt?.sequence, index + 1),
    providerId: attempt?.providerId || null,
    providerName: String(attempt?.providerName || "未选择"),
    startedAt: String(attempt?.startedAt || ""),
    latencyMs: Math.max(0, Number(attempt?.latencyMs || 0)),
    statusCode: Number(attempt?.statusCode || 0),
    outcome: ["success", "failure", "skipped"].includes(attempt?.outcome)
      ? attempt.outcome
      : "failure",
    retryable: Boolean(attempt?.retryable),
    affectsCircuit: attempt?.affectsCircuit !== false,
    failureClass: attempt?.outcome === "success"
      ? ""
      : String(attempt?.failureClass || "unknown"),
    error: truncateText(String(attempt?.error || ""), 2000),
    providerAttempt: positiveInt(attempt?.providerAttempt, 1),
    retryDelayMs: Math.max(0, Number(attempt?.retryDelayMs || 0)),
    usage: normalizeAttemptUsage(attempt?.usage),
    streamDiagnostics: normalizeStreamDiagnostics(attempt?.streamDiagnostics),
    circuitStateBefore: String(attempt?.circuitStateBefore || "unknown"),
    usedHalfOpenPermit: Boolean(attempt?.usedHalfOpenPermit),
  }));
}

export function normalizeAttemptUsage(value) {
  if (!value || typeof value !== "object") return null;
  const normalized = {
    inputTokens: Math.max(0, Number(value.inputTokens || 0)),
    ordinaryInputTokens: Math.max(0, Number(value.ordinaryInputTokens || 0)),
    outputTokens: Math.max(0, Number(value.outputTokens || 0)),
    cacheReadTokens: Math.max(0, Number(value.cacheReadTokens || 0)),
    cacheCreationTokens: Math.max(0, Number(value.cacheCreationTokens || 0)),
    totalTokens: Math.max(0, Number(value.totalTokens || 0)),
    usageFormat: String(value.usageFormat || "unknown"),
    usageObserved: Boolean(value.usageObserved),
  };
  return normalized.usageObserved || normalized.totalTokens > 0 ? normalized : null;
}

export function normalizeStreamDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const eventTypes = value.events?.eventTypes && typeof value.events.eventTypes === "object"
    ? Object.fromEntries(
      Object.entries(value.events.eventTypes)
        .slice(0, 12)
        .map(([name, count]) => [String(name).slice(0, 80), positiveInt(count, 0)]),
    )
    : {};
  return {
    preambleBytes: Math.max(0, Number(value.preambleBytes || 0)),
    probeOutcome: String(value.probeOutcome || ""),
    forwardedBytes: Math.max(0, Number(value.forwardedBytes || 0)),
    forwardedChunks: Math.max(0, Number(value.forwardedChunks || 0)),
    firstByteAt: value.firstByteAt ? String(value.firstByteAt) : null,
    firstByteLatencyMs: value.firstByteLatencyMs === null || value.firstByteLatencyMs === undefined
      ? null
      : Math.max(0, Number(value.firstByteLatencyMs || 0)),
    clientFirstByteLatencyMs: value.clientFirstByteLatencyMs === null || value.clientFirstByteLatencyMs === undefined
      ? null
      : Math.max(0, Number(value.clientFirstByteLatencyMs || 0)),
    lastDataLatencyMs: value.lastDataLatencyMs === null || value.lastDataLatencyMs === undefined
      ? null
      : Math.max(0, Number(value.lastDataLatencyMs || 0)),
    lastChunkAt: value.lastChunkAt ? String(value.lastChunkAt) : null,
    lastProgressAt: value.lastProgressAt ? String(value.lastProgressAt) : null,
    progressTimeoutMs: positiveInt(value.progressTimeoutMs, 0),
    firstForwardedAt: value.firstForwardedAt ? String(value.firstForwardedAt) : null,
    lastForwardedAt: value.lastForwardedAt ? String(value.lastForwardedAt) : null,
    outputStarted: Boolean(value.outputStarted || Number(value.forwardedBytes || 0) > 0),
    termination: String(value.termination || ""),
    completed: Boolean(value.completed),
    events: {
      totalEvents: Math.max(0, Number(value.events?.totalEvents || 0)),
      validatedEvents: Math.max(0, Number(value.events?.validatedEvents || 0)),
      unparsedEvents: Math.max(0, Number(value.events?.unparsedEvents || 0)),
      semanticStarted: Boolean(value.events?.semanticStarted),
      completed: Boolean(value.events?.completed),
      eventTypes,
    },
  };
}

export function emptyUsageBucket(name) {
  return {
    name,
    requests: 0,
    inputTokens: 0,
    ordinaryInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  };
}

export function addUsageTotals(target, record) {
  target.inputTokens += Number(record.inputTokens || 0);
  target.ordinaryInputTokens = Number(target.ordinaryInputTokens || 0) + Number(
    record.ordinaryInputTokens ??
      Math.max(
        0,
        Number(record.inputTokens || 0) -
          Number(record.cacheReadTokens || 0) -
          Number(record.cacheCreationTokens || 0),
      ),
  );
  target.outputTokens += Number(record.outputTokens || 0);
  target.cacheReadTokens += Number(record.cacheReadTokens || 0);
  target.cacheCreationTokens += Number(record.cacheCreationTokens || 0);
  target.totalTokens += Number(record.totalTokens || 0);
  target.estimatedCostUsd += Number(record.estimatedCostUsd || 0);
}

export function compareUsageBuckets(a, b) {
  return (b.estimatedCostUsd - a.estimatedCostUsd) ||
    (b.totalTokens - a.totalTokens) ||
    String(a.name).localeCompare(String(b.name), "zh-CN");
}

export function extractRequestModel(body) {
  if (!body?.length) return "";
  try {
    const json = JSON.parse(Buffer.from(body).toString("utf8"));
    return String(json?.model || "");
  } catch {
    return "";
  }
}

export function extractUsage(responseBody, responseText) {
  const usage = {
    model: "",
    inputTokens: 0,
    ordinaryInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    usageFormat: "unknown",
    usageObserved: false,
    rawUsage: null,
  };
  const candidates = [];

  if (responseBody?.length) {
    try {
      candidates.push(JSON.parse(Buffer.from(responseBody).toString("utf8")));
    } catch {}
  }

  if (responseText) {
    for (const line of String(responseText).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {}
    }
  }

  for (const item of candidates) {
    mergeUsage(usage, item);
  }
  usage.totalTokens ||= usage.inputTokens + usage.outputTokens;
  return usage;
}

export function normalizeBillingModel(model) {
  const value = String(model || "").trim();
  if (!value) return "unknown";
  const normalized = value.toLowerCase();
  if (
    /^gpt-5\.[45](?:$|[-_.:])/.test(normalized) ||
    /^codex-5\.[45](?:$|[-_.:])/.test(normalized) ||
    /^gpt-5[45](?:$|[-_.:])/.test(normalized) ||
    /^codex-5[45](?:$|[-_.:])/.test(normalized)
  ) {
    return GPT_55_BILLING_MODEL;
  }
  return value;
}

export function detectFastBillingMode(requestBody, responseBody, responseText) {
  const candidates = [];
  pushJsonCandidate(candidates, requestBody);
  pushJsonCandidate(candidates, responseBody);
  if (responseText) {
    for (const line of String(responseText).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      pushJsonTextCandidate(candidates, data);
    }
  }
  return candidates.some(hasFastBillingSignal);
}

function pushJsonCandidate(candidates, body) {
  if (!body?.length) return;
  pushJsonTextCandidate(candidates, Buffer.from(body).toString("utf8"));
}

function pushJsonTextCandidate(candidates, text) {
  try {
    candidates.push(JSON.parse(text));
  } catch {}
}

function hasFastBillingSignal(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (
    payload.service_tier === "priority" ||
    payload.serviceTier === "priority" ||
    payload.priority === true ||
    payload.fast === true ||
    payload.fastMode === true ||
    payload.fast_mode === true ||
    payload.metadata?.fastMode === true ||
    payload.metadata?.fast_mode === true
  ) {
    return true;
  }
  if (payload.response && typeof payload.response === "object") {
    return hasFastBillingSignal(payload.response);
  }
  return false;
}

function mergeUsage(target, payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.model) {
    target.model = String(payload.model);
  }
  // Responses/SSE 有时把实际模型放在 response.model；即使同一事件同时带 usage，
  // 也必须保留它，供 CCOK 校验请求模型是否真的被上游接受。
  if (payload.response?.model) {
    target.model = String(payload.response.model);
  }
  const usage = payload.usage || payload.response?.usage;
  if (!usage || typeof usage !== "object") {
    if (payload.response && typeof payload.response === "object") {
      mergeUsage(target, payload.response);
    }
    return;
  }
  const normalized = normalizeRawUsage(usage);
  target.inputTokens = Math.max(target.inputTokens, normalized.inputTokens);
  target.ordinaryInputTokens = Math.max(
    target.ordinaryInputTokens,
    normalized.ordinaryInputTokens,
  );
  target.outputTokens = Math.max(target.outputTokens, normalized.outputTokens);
  target.cacheReadTokens = Math.max(target.cacheReadTokens, normalized.cacheReadTokens);
  target.cacheCreationTokens = Math.max(
    target.cacheCreationTokens,
    normalized.cacheCreationTokens,
  );
  target.totalTokens = Math.max(target.totalTokens, normalized.totalTokens);
  target.usageObserved ||= normalized.usageObserved;
  if (normalized.usageFormat !== "unknown") {
    target.usageFormat = normalized.usageFormat;
  }
  if (
    !target.rawUsage ||
    JSON.stringify(usage).length >= JSON.stringify(target.rawUsage).length
  ) {
    target.rawUsage = structuredClone(usage);
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}
