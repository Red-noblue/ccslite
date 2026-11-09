/**
 * 供应商价格实验服务。
 * 独立管理实验请求、逐条扣费、长期校准、价格拟合和 JSON 状态持久化。
 */

import crypto from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  calculateActualCost,
  calculateUsageCost,
  emptyNormalizedUsage,
  fitEffectivePrices,
  normalizePriceUsage,
  priceVectorFromUsage,
  roundPrecise,
} from "./price-calculation.js";
import {
  formatFetchError,
  nonRetryableError,
} from "./proxy-errors.js";
import {
  buildProviderOnlyHeaders,
  joinUpstreamUrl,
  rectifyRequestBody,
} from "./upstream-request.js";
import { getProviderDispatcher } from "./upstream-proxy.js";
import { extractUsage } from "./usage-records.js";

const PRICE_EXPERIMENT_TIMEOUT_MS = 180_000;
const REASONING_EFFORTS = new Set(["", "none", "minimal", "low", "medium", "high", "xhigh"]);
const PRICE_EXPERIMENT_KINDS = new Set([
  "input_short",
  "input_long",
  "output_long",
  "cache_write",
  "cache_read",
]);

export function createPriceLabService({
  filePath,
  findProvider,
  getUsageRecords,
  normalizeUsageRecord,
  extractTextFromPayload,
  requestTimeoutMs = PRICE_EXPERIMENT_TIMEOUT_MS,
  startProviderActivity = () => () => {},
  getExchangeRate = async () => null,
}) {
  const state = {
    loaded: false,
    samples: [],
    checkpoints: [],
    profiles: {},
  };

  async function load() {
    if (state.loaded) return;
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8"));
      state.samples = Array.isArray(raw.samples) ? raw.samples : [];
      state.checkpoints = Array.isArray(raw.checkpoints) ? raw.checkpoints : [];
      state.profiles = raw.profiles && typeof raw.profiles === "object"
        ? raw.profiles
        : {};
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`读取价格实验数据失败，已从空数据启动: ${error.message}`);
      }
    }
    state.loaded = true;
    refreshProfiles(false);
  }

  async function save() {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify({
        version: 1,
        samples: state.samples,
        checkpoints: state.checkpoints,
        profiles: state.profiles,
      }, null, 2)}\n`, "utf8");
      await rename(tmpPath, filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  async function runExperiment(payload = {}) {
    await load();
    const pending = state.samples.find((sample) => sample.valid !== false && !sample.billing);
    if (pending) {
      throw nonRetryableError(`请先录入 ${pending.providerName} 上一条实验请求的扣费，或将其标记为无效。`, 409);
    }
    const provider = findProvider(String(payload.providerId || ""));
    if (
      !provider?.baseUrl ||
      (provider.authMode === "api_key" && !provider.apiKey) ||
      provider.authMode === "client_session"
    ) {
      throw nonRetryableError("请选择已配置 Base URL 和可用认证方式的供应商。", 400);
    }
    const requestModel = String(payload.model || "").trim();
    if (!requestModel) {
      throw nonRetryableError("价格实验模型不能为空。", 400);
    }
    const reasoningEffort = String(payload.reasoningEffort ?? "").trim();
    if (!REASONING_EFFORTS.has(reasoningEffort)) {
      throw nonRetryableError("请选择有效的思考强度。", 400);
    }
    const kind = PRICE_EXPERIMENT_KINDS.has(payload.kind)
      ? payload.kind
      : "input_short";
    const currency = normalizeCurrency(payload.currency);
    let selectedCacheKey = String(payload.cacheKey || "").trim();
    if (kind === "cache_read" && !selectedCacheKey) {
      selectedCacheKey = [...state.samples]
        .reverse()
        .find((sample) =>
          sample.providerId === provider.id &&
          sample.requestModel === requestModel &&
          sample.currency === currency &&
          sample.kind === "cache_write" &&
          sample.valid !== false &&
          sample.cacheKey,
        )?.cacheKey || "";
    }
    const requestSpec = buildPriceExperimentRequest({
      kind,
      model: requestModel,
      reasoningEffort,
      cacheKey: selectedCacheKey,
    });
    if (kind === "cache_read") {
      const matchingCacheSample = state.samples.find((sample) =>
        sample.providerId === provider.id &&
        sample.requestModel === requestModel &&
        sample.cacheKey === requestSpec.cacheKey &&
        sample.kind === "cache_write" &&
        sample.valid !== false,
      );
      if (!matchingCacheSample) {
        throw nonRetryableError("缓存读取实验需要先选择同一供应商和模型的缓存写入样本。", 400);
      }
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let statusCode = 0;
    let responseBody = Buffer.alloc(0);
    let errorMessage = "";
    let finishActivity;
    try {
      const url = joinUpstreamUrl(provider.baseUrl, "/v1/responses", "", provider);
      const headers = await buildProviderOnlyHeaders(provider);
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json");
      const requestBody = rectifyRequestBody(provider, Buffer.from(JSON.stringify(requestSpec.body)));
      finishActivity = startProviderActivity(provider);
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: requestBody,
        signal: controller.signal,
        dispatcher: getProviderDispatcher(provider),
      });
      statusCode = response.status;
      responseBody = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        errorMessage = safeTextFromBuffer(responseBody) || `HTTP ${response.status}`;
      }
    } catch (error) {
      errorMessage = formatFetchError(error);
    } finally {
      clearTimeout(timer);
      finishActivity?.();
    }

    const usage = extractUsage(responseBody, null);
    const sample = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      providerId: provider.id,
      providerName: provider.name,
      requestModel,
      reasoningEffort,
      responseModel: usage.model || requestModel,
      kind,
      cacheKey: requestSpec.cacheKey || "",
      currency,
      statusCode,
      latencyMs: Date.now() - startedAt,
      error: truncateText(errorMessage, 2000),
      responsePreview: truncateText(extractTextFromResponseBuffer(responseBody), 300),
      promptFingerprint: requestSpec.promptFingerprint,
      usage: normalizePriceUsage(usage),
      rawUsage: usage.rawUsage,
      billing: null,
      valid: true,
    };
    state.samples.push(sample);
    await save();
    return sanitizePriceSample(sample);
  }

  async function updateSample(sampleId, payload = {}) {
    await load();
    const sample = state.samples.find((item) => item.id === sampleId);
    if (!sample) {
      throw nonRetryableError("价格实验样本不存在。", 404);
    }
    if (payload.valid === false) {
      sample.valid = false;
      sample.invalidReason = truncateText(String(payload.invalidReason || "用户标记为无效"), 300);
      sample.updatedAt = new Date().toISOString();
    } else if (payload.billing && typeof payload.billing === "object") {
      const ledgerCharge = requiredNonNegativeNumber(payload.billing.ledgerCharge, "账面扣费");
      const numerator = requiredNonNegativeNumber(payload.billing.numerator ?? 1, "折算分子");
      const denominator = requiredPositiveNumber(payload.billing.denominator ?? 1, "折算分母");
      const exchangeRate = sample.billing ? sample.billing.exchangeRate || null : await getExchangeRate();
      sample.currency = normalizeCurrency(payload.billing.currency || sample.currency);
      sample.billing = {
        ledgerCharge,
        numerator,
        denominator,
        actualCost: calculateActualCost(ledgerCharge, numerator, denominator),
        enteredAt: new Date().toISOString(),
        exchangeRate,
      };
      sample.valid = true;
      sample.updatedAt = new Date().toISOString();
    } else {
      throw nonRetryableError("请提交本次账面扣费，或将样本标记为无效。", 400);
    }
    refreshProfiles(true);
    await save();
    return sanitizePriceSample(sample);
  }

  async function deleteSample(sampleId) {
    await load();
    const index = state.samples.findIndex((item) => item.id === sampleId);
    if (index < 0) {
      throw nonRetryableError("价格实验样本不存在。", 404);
    }
    const [deleted] = state.samples.splice(index, 1);
    refreshProfiles(true);
    await save();
    return sanitizePriceSample(deleted);
  }

  async function createCheckpoint(payload = {}) {
    await load();
    const provider = findProvider(String(payload.providerId || ""));
    if (!provider) throw nonRetryableError("长期校准供应商不存在。", 404);
    const model = String(payload.model || "").trim();
    if (!model) throw nonRetryableError("长期校准模型不能为空。", 400);
    const currency = normalizeCurrency(payload.currency);
    const cumulativeLedgerCharge = requiredNonNegativeNumber(
      payload.cumulativeLedgerCharge,
      "Key 累计账面花费",
    );
    const numerator = requiredNonNegativeNumber(payload.numerator ?? 1, "折算分子");
    const denominator = requiredPositiveNumber(payload.denominator ?? 1, "折算分母");
    const mode = payload.mode === "baseline" ? "baseline" : "checkpoint";
    const now = new Date();
    const groupKey = priceProfileKey(provider.id, model, currency);
    const previous = [...state.checkpoints].reverse().find((item) =>
      item.groupKey === groupKey,
    );
    if (mode === "checkpoint" && !previous) {
      throw nonRetryableError("请先为这个供应商和模型建立长期校准基线。", 400);
    }
    if (
      mode === "checkpoint" &&
      cumulativeLedgerCharge < Number(previous.cumulativeLedgerCharge || 0)
    ) {
      throw nonRetryableError("累计花费小于上一个校准点，请建立新基线。", 400);
    }

    const checkpoint = {
      id: crypto.randomUUID(),
      timestamp: now.toISOString(),
      type: mode,
      groupKey,
      providerId: provider.id,
      providerName: provider.name,
      model,
      currency,
      cumulativeLedgerCharge,
      numerator,
      denominator,
    };
    if (mode === "checkpoint") {
      const usage = aggregateProviderUsage({
        providerId: provider.id,
        model,
        startAt: previous.timestamp,
        endAt: checkpoint.timestamp,
      });
      const ledgerChargeDelta = roundPrecise(
        cumulativeLedgerCharge - Number(previous.cumulativeLedgerCharge || 0),
      );
      const actualCost = calculateActualCost(ledgerChargeDelta, numerator, denominator);
      const profile = state.profiles[groupKey];
      checkpoint.previousCheckpointId = previous.id;
      checkpoint.ledgerChargeDelta = ledgerChargeDelta;
      checkpoint.actualCost = actualCost;
      checkpoint.exchangeRate = await getExchangeRate();
      checkpoint.usage = usage;
      checkpoint.predictedCost = profile
        ? calculateUsageCost(usage, profile.rates)
        : null;
      checkpoint.deviationRate = checkpoint.predictedCost > 0
        ? roundPrecise((actualCost - checkpoint.predictedCost) / checkpoint.predictedCost)
        : null;
    }
    state.checkpoints.push(checkpoint);
    refreshProfiles(true);
    await save();
    return sanitizePriceCheckpoint(checkpoint);
  }

  async function deleteCheckpoint(checkpointId) {
    await load();
    const index = state.checkpoints.findIndex((item) => item.id === checkpointId);
    if (index < 0) {
      throw nonRetryableError("长期校准记录不存在。", 404);
    }
    const [deleted] = state.checkpoints.splice(index, 1);
    refreshProfiles(true);
    await save();
    return sanitizePriceCheckpoint(deleted);
  }

  function refreshProfiles(preserveHistory = true) {
    const groups = new Map();
    for (const sample of state.samples) {
      if (sample.valid === false || !sample.billing || !sample.usage?.usageObserved) continue;
      const key = priceProfileKey(sample.providerId, sample.requestModel, sample.currency);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        sourceType: "single_request",
        sourceId: sample.id,
        tokens: priceVectorFromUsage(sample.usage),
        actualCost: Number(sample.billing.actualCost || 0),
        kind: sample.kind,
      });
    }
    for (const checkpoint of state.checkpoints) {
      if (checkpoint.type !== "checkpoint" || !checkpoint.usage?.usageObserved) continue;
      if (!groups.has(checkpoint.groupKey)) groups.set(checkpoint.groupKey, []);
      groups.get(checkpoint.groupKey).push({
        sourceType: "long_term_checkpoint",
        sourceId: checkpoint.id,
        tokens: priceVectorFromUsage(checkpoint.usage),
        actualCost: Number(checkpoint.actualCost || 0),
        kind: "long_term",
      });
    }

    const nextProfiles = {};
    for (const [groupKey, equations] of groups.entries()) {
      const [providerId, model, currency] = groupKey.split("::");
      const providerName = findProvider(providerId)?.name ||
        state.samples.find((item) => item.providerId === providerId)?.providerName ||
        providerId;
      const fit = fitEffectivePrices(equations);
      const previous = state.profiles[groupKey];
      nextProfiles[groupKey] = {
        groupKey,
        providerId,
        providerName,
        model,
        currency,
        ...fit,
        updatedAt: new Date().toISOString(),
        history: preserveHistory && previous
          ? [...(Array.isArray(previous.history) ? previous.history : []), profileHistoryEntry(previous)]
          : Array.isArray(previous?.history) ? previous.history : [],
      };
    }
    state.profiles = nextProfiles;
  }

  function aggregateProviderUsage({ providerId, model, startAt, endAt }) {
    const result = {
      ...emptyNormalizedUsage(),
      requestRecords: 0,
      observedAttempts: 0,
      unknownAttempts: 0,
    };
    const startMs = Date.parse(startAt || "");
    const endMs = Date.parse(endAt || "");
    for (const rawRecord of getUsageRecords()) {
      const record = normalizeUsageRecord(rawRecord);
      const timestampMs = Date.parse(record.timestamp || "");
      if (!Number.isFinite(timestampMs) || timestampMs <= startMs || timestampMs > endMs) continue;
      if (model && record.requestModel !== model && record.responseModel !== model) continue;
      const attempts = Array.isArray(record.providerAttempts)
        ? record.providerAttempts.filter((attempt) => attempt.providerId === providerId)
        : [];
      const observedAttempts = attempts.filter((attempt) => attempt.usage?.usageObserved);
      if (observedAttempts.length) {
        for (const attempt of observedAttempts) addCanonicalUsage(result, attempt.usage);
        result.observedAttempts += observedAttempts.length;
        result.unknownAttempts += Math.max(0, attempts.length - observedAttempts.length);
        result.requestRecords += 1;
        continue;
      }
      if (record.providerId === providerId && record.usageObserved) {
        addCanonicalUsage(result, record);
        result.observedAttempts += 1;
        result.unknownAttempts += attempts.length;
        result.requestRecords += 1;
      } else {
        result.unknownAttempts += attempts.length;
      }
    }
    result.usageObserved = result.observedAttempts > 0;
    result.usageFormat = "aggregated";
    result.cacheReadRate = result.inputTokens > 0
      ? roundPrecise(result.cacheReadTokens / result.inputTokens)
      : null;
    result.cacheCreationRate = result.inputTokens > 0
      ? roundPrecise(result.cacheCreationTokens / result.inputTokens)
      : null;
    return result;
  }

  function extractTextFromResponseBuffer(buffer) {
    if (!buffer?.length) return "";
    try {
      return extractTextFromPayload(JSON.parse(buffer.toString("utf8"))).trim();
    } catch {
      return "";
    }
  }

  return {
    load,
    runExperiment,
    updateSample,
    deleteSample,
    createCheckpoint,
    deleteCheckpoint,
    buildPayload: () => ({
      samples: [...state.samples].reverse().map(sanitizePriceSample),
      pendingSample: sanitizePriceSample(
        [...state.samples].reverse().find((sample) => sample.valid !== false && !sample.billing),
      ),
      checkpoints: [...state.checkpoints].reverse().map(sanitizePriceCheckpoint),
      profiles: Object.values(state.profiles).map(sanitizePriceProfile),
    }),
  };
}

function buildPriceExperimentRequest({ kind, model, reasoningEffort, cacheKey }) {
  const nonce = crypto.randomUUID();
  let input;
  let maxOutputTokens = 32;
  let resolvedCacheKey = "";
  if (kind === "input_long") {
    input = `价格实验 ${nonce}。请阅读以下唯一内容，只回复 PRICEOK。\n${buildRepeatedPrompt(32)}`;
  } else if (kind === "output_long") {
    input = `价格实验 ${nonce}。请输出从 001 到 160 的编号，每行一个编号，不要解释。`;
    maxOutputTokens = 640;
  } else if (kind === "cache_write" || kind === "cache_read") {
    resolvedCacheKey = String(cacheKey || "").trim() || crypto.randomUUID();
    input = [
      `CCSLITE-CACHE-PRICE-LAB:${resolvedCacheKey}`,
      buildRepeatedPrompt(96),
      "请只回复 CACHEOK。",
    ].join("\n");
  } else {
    input = `价格实验 ${nonce}。请只回复 PRICEOK。`;
  }
  const body = {
    model,
    input,
    max_output_tokens: maxOutputTokens,
    stream: false,
  };
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  return {
    body,
    cacheKey: resolvedCacheKey,
    promptFingerprint: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16),
  };
}

function buildRepeatedPrompt(repeats) {
  const sentence = "数字通信系统使用确定的同步序列进行误码测量，本段仅用于形成稳定且可重复的缓存前缀。";
  return Array.from({ length: repeats }, (_, index) => `${String(index + 1).padStart(3, "0")} ${sentence}`).join("\n");
}

function addCanonicalUsage(target, usage) {
  target.inputTokens += Number(usage.inputTokens || 0);
  target.ordinaryInputTokens += Number(
    usage.ordinaryInputTokens ??
      Math.max(
        0,
        Number(usage.inputTokens || 0) -
          Number(usage.cacheReadTokens || 0) -
          Number(usage.cacheCreationTokens || 0),
      ),
  );
  target.outputTokens += Number(usage.outputTokens || 0);
  target.cacheReadTokens += Number(usage.cacheReadTokens || 0);
  target.cacheCreationTokens += Number(usage.cacheCreationTokens || 0);
  target.totalTokens += Number(usage.totalTokens || 0);
}

function sanitizePriceSample(sample) {
  if (!sample) return null;
  return {
    ...sample,
    rawUsage: sample.rawUsage || null,
  };
}

function sanitizePriceCheckpoint(checkpoint) {
  return checkpoint ? { ...checkpoint } : null;
}

function sanitizePriceProfile(profile) {
  if (!profile) return null;
  return {
    ...profile,
    history: undefined,
  };
}

function profileHistoryEntry(profile) {
  return {
    rates: profile.rates,
    status: profile.status,
    equationCount: profile.equationCount,
    relativeError: profile.relativeError,
    updatedAt: profile.updatedAt,
  };
}

function priceProfileKey(providerId, model, currency) {
  return `${String(providerId)}::${String(model)}::${normalizeCurrency(currency)}`;
}

function normalizeCurrency(value) {
  const currency = String(value || "CNY").trim().toUpperCase();
  return /^[A-Z0-9_-]{2,12}$/.test(currency) ? currency : "CNY";
}

function requiredNonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw nonRetryableError(`${label}必须是大于或等于 0 的数字。`, 400);
  }
  return number;
}

function requiredPositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw nonRetryableError(`${label}必须是大于 0 的数字。`, 400);
  }
  return number;
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
