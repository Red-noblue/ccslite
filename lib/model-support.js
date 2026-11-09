/**
 * 模型支持证据、供应商模型排序和连通性间隔的纯逻辑模块。
 * 本模块不持有服务运行状态，便于独立测试并减少服务器入口的职责。
 */

import { compareProviders } from "./provider-order.js";

const MODEL_SUPPORTED_TTL_MS = 6 * 60 * 60_000;
const MODEL_UNSUPPORTED_TTL_MS = 30 * 60_000;
const MIN_CONNECTIVITY_INTERVAL_MS = 30 * 60_000;
const MAX_CONNECTIVITY_INTERVAL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_CONNECTIVITY_INTERVAL_MS = 3 * 60 * 60_000;

export function normalizeModelSupport(value, nowMs = Date.now()) {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const lastTestedAt = String(input.lastTestedAt || input.last_tested_at || "");
  const evidenceInput = input.modelEvidence || input.model_evidence;
  const hasEvidence = evidenceInput && typeof evidenceInput === "object" && !Array.isArray(evidenceInput);
  const modelEvidence = {};

  if (hasEvidence) {
    for (const [model, evidence] of Object.entries(evidenceInput)) {
      const normalized = normalizeModelEvidence(evidence, nowMs);
      const modelName = String(model || "").trim();
      if (modelName && normalized) modelEvidence[modelName] = normalized;
    }
  } else {
    const checkedAtMs = Date.parse(lastTestedAt);
    const legacyCheckedAtMs = Number.isFinite(checkedAtMs) ? Math.min(checkedAtMs, nowMs) : 0;
    for (const model of uniqueStrings(input.supportedModels || input.supported_models || [])) {
      modelEvidence[model] = buildModelEvidence(
        "supported",
        "legacy_config",
        "legacy_supported_list",
        legacyCheckedAtMs,
      );
    }
    for (const model of uniqueStrings(input.unsupportedModels || input.unsupported_models || [])) {
      modelEvidence[model] = buildModelEvidence(
        "unsupported",
        "legacy_config",
        "legacy_unsupported_list",
        legacyCheckedAtMs,
      );
    }
  }

  const supportedModels = [];
  const unsupportedModels = [];
  for (const [model, evidence] of Object.entries(modelEvidence)) {
    const expiresAtMs = Date.parse(evidence.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) continue;
    if (evidence.state === "supported") supportedModels.push(model);
    if (evidence.state === "unsupported") unsupportedModels.push(model);
  }

  return {
    preferredTestModel: String(input.preferredTestModel || input.preferred_test_model || ""),
    supportedModels: uniqueStrings(supportedModels),
    unsupportedModels: uniqueStrings(unsupportedModels),
    lastTestedAt,
    modelEvidence,
  };
}

export function applyManualModelSupport(currentValue, patchValue, nowMs = Date.now()) {
  const support = normalizeModelSupport(currentValue, nowMs);
  const patch = patchValue && typeof patchValue === "object" && !Array.isArray(patchValue)
    ? patchValue
    : {};
  if (Object.prototype.hasOwnProperty.call(patch, "preferredTestModel")) {
    support.preferredTestModel = String(patch.preferredTestModel || "").trim();
  }
  if (
    !Object.prototype.hasOwnProperty.call(patch, "supportedModels") &&
    !Object.prototype.hasOwnProperty.call(patch, "unsupportedModels")
  ) {
    return normalizeModelSupport(support, nowMs);
  }

  const unsupportedModels = uniqueStrings(patch.unsupportedModels || []);
  const unsupportedSet = new Set(unsupportedModels);
  const supportedModels = uniqueStrings(patch.supportedModels || [])
    .filter((model) => !unsupportedSet.has(model));
  const manuallyManagedModels = uniqueStrings([
    ...support.supportedModels,
    ...support.unsupportedModels,
    ...supportedModels,
    ...unsupportedModels,
  ]);
  for (const model of manuallyManagedModels) {
    delete support.modelEvidence[model];
  }
  for (const model of supportedModels) {
    support.modelEvidence[model] = buildModelEvidence(
      "supported",
      "manual_config",
      "manual_supported_list",
      nowMs,
    );
  }
  for (const model of unsupportedModels) {
    support.modelEvidence[model] = buildModelEvidence(
      "unsupported",
      "manual_config",
      "manual_unsupported_list",
      nowMs,
    );
  }
  return normalizeModelSupport(support, nowMs);
}

export function getModelAvailability(provider, model, nowMs = Date.now()) {
  const modelName = String(model || "").trim();
  if (!modelName) return { state: "unknown", source: "", expiresAt: "", reason: "" };
  const support = normalizeModelSupport(provider?.modelSupport, nowMs);
  const evidence = support.modelEvidence[modelName];
  if (!evidence) return { state: "unknown", source: "", expiresAt: "", reason: "" };
  const expiresAtMs = Date.parse(evidence.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return {
      ...evidence,
      state: evidence.state === "supported" ? "stale_supported" : "unknown",
    };
  }
  return { ...evidence };
}

export function orderProvidersForModel(providers, model, nowMs = Date.now()) {
  return providers
    .filter((provider) => getModelAvailability(provider, model, nowMs).state !== "unsupported")
    .sort(compareProviders);
}

export function preferredProviderRetryDelay({
  providerIndex,
  providerAttempt,
  providerAttemptLimit,
  failureClass,
  providerElapsedMs,
  proxyConfig,
}) {
  if (providerIndex !== 0 || providerAttempt >= providerAttemptLimit) return 0;
  return providerRetryDelay({
    providerIndex,
    providerAttempt,
    failureClass,
    providerElapsedMs,
    proxyConfig,
  });
}

// 所有供应商共用指数退避；首选供应商和后续供应商只在尝试预算上不同。
export function providerRetryDelay({
  providerIndex = 0,
  providerAttempt,
  failureClass,
  providerElapsedMs,
  proxyConfig,
}) {
  if (!["transport", "capacity", "rate_limited", "authentication", "upstream_5xx",
    "stream_protocol", "stream_progress_timeout"].includes(failureClass)) {
    return 0;
  }
  const isPreferred = Number(providerIndex) === 0;
  const baseDelayMs = positiveInt(
    isPreferred
      ? proxyConfig?.preferredProviderRetryDelayMs ?? proxyConfig?.providerRetryDelayMs
      : proxyConfig?.providerRetryDelayMs ?? proxyConfig?.preferredProviderRetryDelayMs,
    2_000,
  );
  const maxDelayMs = positiveInt(
    isPreferred
      ? proxyConfig?.preferredProviderRetryMaxDelayMs ?? proxyConfig?.providerRetryMaxDelayMs
      : proxyConfig?.providerRetryMaxDelayMs ?? proxyConfig?.preferredProviderRetryMaxDelayMs,
    5_000,
  );
  const retryBudgetMs = positiveInt(
    isPreferred
      ? proxyConfig?.preferredProviderRetryBudgetMs ?? proxyConfig?.providerRetryBudgetMs
      : proxyConfig?.providerRetryBudgetMs ?? proxyConfig?.preferredProviderRetryBudgetMs,
    20_000,
  );
  const attempt = Math.max(1, Number(providerAttempt) || 1);
  const delayMs = Math.min(baseDelayMs * (2 ** (attempt - 1)), maxDelayMs);
  return Number(providerElapsedMs || 0) + delayMs <= retryBudgetMs ? delayMs : 0;
}

export function rememberProviderModelEvidence(
  provider,
  model,
  state,
  source,
  reason,
  nowMs = Date.now(),
) {
  const modelName = String(model || "").trim();
  if (!provider || !modelName || !["supported", "unsupported"].includes(state)) return false;
  const support = normalizeModelSupport(provider.modelSupport, nowMs);
  const current = support.modelEvidence[modelName];
  const ttlMs = state === "supported" ? MODEL_SUPPORTED_TTL_MS : MODEL_UNSUPPORTED_TTL_MS;
  const currentExpiresAtMs = Date.parse(current?.expiresAt || "");
  const sourcePriority = { legacy_config: 0, provider_test: 1, upstream_error: 2, actual_request: 3 };
  const currentPriority = sourcePriority[current?.source] ?? 0;
  const nextPriority = sourcePriority[source] ?? 0;
  if (
    current?.state === state &&
    currentPriority >= nextPriority &&
    Number.isFinite(currentExpiresAtMs) &&
    currentExpiresAtMs > nowMs + ttlMs / 2
  ) {
    return false;
  }

  support.modelEvidence[modelName] = buildModelEvidence(state, source, reason, nowMs);
  provider.modelSupport = normalizeModelSupport(support, nowMs);
  return true;
}

export function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

export function normalizeConnectivityInterval(value, fallback = DEFAULT_CONNECTIVITY_INTERVAL_MS) {
  if (value === null || value === "never") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(
    MAX_CONNECTIVITY_INTERVAL_MS,
    Math.max(MIN_CONNECTIVITY_INTERVAL_MS, Math.floor(parsed)),
  );
}

export function normalizeConnectivityCandidateModels(value, fallback) {
  if (!Array.isArray(value)) return uniqueStrings(fallback);
  const models = uniqueStrings(value).slice(0, 10);
  return models.length > 0 ? models : uniqueStrings(fallback);
}

export function formatConnectivityInterval(intervalMs) {
  if (intervalMs === null) return "永不";
  if (intervalMs === 30 * 60_000) return "0.5h";
  if (intervalMs < 24 * 60 * 60_000) return `${intervalMs / 60 / 60_000}h`;
  if (intervalMs === MAX_CONNECTIVITY_INTERVAL_MS) return "1个月";
  return `${intervalMs / 24 / 60 / 60_000}d`;
}

function normalizeModelEvidence(value, nowMs = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = ["supported", "unsupported"].includes(value.state)
    ? value.state
    : "";
  if (!state) return null;
  const checkedAtMs = Date.parse(value.checkedAt || value.checked_at || "");
  const normalizedCheckedAtMs = Number.isFinite(checkedAtMs) ? checkedAtMs : nowMs;
  const expiresAtMs = Date.parse(value.expiresAt || value.expires_at || "");
  const ttlMs = state === "supported" ? MODEL_SUPPORTED_TTL_MS : MODEL_UNSUPPORTED_TTL_MS;
  return {
    state,
    source: String(value.source || "unknown"),
    checkedAt: new Date(normalizedCheckedAtMs).toISOString(),
    expiresAt: new Date(
      Number.isFinite(expiresAtMs) ? expiresAtMs : normalizedCheckedAtMs + ttlMs,
    ).toISOString(),
    reason: String(value.reason || ""),
  };
}

function buildModelEvidence(state, source, reason, checkedAtMs) {
  const normalizedCheckedAtMs = Number.isFinite(checkedAtMs) ? checkedAtMs : 0;
  const ttlMs = state === "supported" ? MODEL_SUPPORTED_TTL_MS : MODEL_UNSUPPORTED_TTL_MS;
  return {
    state,
    source,
    checkedAt: new Date(normalizedCheckedAtMs).toISOString(),
    expiresAt: new Date(normalizedCheckedAtMs + ttlMs).toISOString(),
    reason,
  };
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
