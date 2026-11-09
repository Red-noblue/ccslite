/** 中文用量查询服务：完整历史汇总、有界缓存、稳定分页和趋势聚合，不修改历史记录。 */
import crypto from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { addUsageTotals, compareUsageBuckets, emptyUsageBucket, isCcokProbeUsageRecord } from "./usage-records.js";
import { usageGroupId } from "./group-usage.js";
const clampNumber = (value, fallback, min, max) => Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.max(min, Math.min(max, Number(value))) : fallback;
export function computeBillingSummary(records, filters = {}, { normalizeUsageRecord, pricing = {}, now = Date.now } = {}) {
  const calculation = billingSummaryChunks(records, filters, { normalizeUsageRecord, pricing, now });
  let step;
  do { step = calculation.next(); } while (!step.done);
  return step.value;
}

// 冷查询分批让出事件循环，转发中的 SSE 和新业务请求可以继续处理。
export async function computeBillingSummaryAsync(records, filters = {}, options = {}) {
  const calculation = billingSummaryChunks(records, filters, options);
  for (;;) {
    const step = calculation.next();
    if (step.done) return step.value;
    await nextTurn();
  }
}

function* billingSummaryChunks(records, filters, { normalizeUsageRecord, pricing = {}, now = Date.now }) {
  const startMs = parseOptionalTime(filters.startAt);
  const endMs = parseOptionalTime(filters.endAt);
  const timezoneOffset = clampNumber(filters.timezoneOffset, 0, -840, 840);
  const todayKey = new Date(now() - timezoneOffset * 60_000).toISOString().slice(0, 10);
  const summary = createBillingAccumulator(pricing);
  const business = createBillingAccumulator(pricing);
  const ccok = createBillingAccumulator(pricing);
  const today = createBillingAccumulator(pricing);
  const todayBusiness = createBillingAccumulator(pricing);
  const todayCcok = createBillingAccumulator(pricing);

  let scanned = 0;
  for (const record of records) {
    if (++scanned % 2000 === 0) yield;
    if (filters.groupId && usageGroupId(record) !== filters.groupId) continue;
    if (filters.providerId && record.providerId !== filters.providerId) continue;
    const timestampMs = Date.parse(record.timestamp || "");
    if (startMs !== null && (!Number.isFinite(timestampMs) || timestampMs < startMs)) continue;
    if (endMs !== null && (!Number.isFinite(timestampMs) || timestampMs > endMs)) continue;
    const normalizedRecord = normalizeUsageRecord(record, pricing);
    const dayKey = Number.isFinite(timestampMs)
      ? new Date(timestampMs - timezoneOffset * 60_000).toISOString().slice(0, 10)
      : "未知日期";
    normalizedRecord.dayKey = dayKey;
    addBillingRecord(summary, normalizedRecord);
    addBillingRecord(
      isCcokProbeUsageRecord(normalizedRecord) ? ccok : business,
      normalizedRecord,
    );
    if (dayKey === todayKey) {
      const probe = isCcokProbeUsageRecord(normalizedRecord);
      addBillingRecord(today, normalizedRecord);
      addBillingRecord(probe ? todayCcok : todayBusiness, normalizedRecord);
    }
  }

  return {
    ...finalizeBillingAccumulator(summary),
    groupId: filters.groupId || null,
    // 保留业务与 CCOK 两个独立视图；顶层字段继续表示全部实际流量。
    business: finalizeBillingAccumulator(business),
    ccok: finalizeBillingAccumulator(ccok),
    // 今日按请求方时区计算，供应商卡片只使用今日业务分项；不重复扫描日志。
    today: {
      ...finalizeBillingAccumulator(today),
      business: finalizeBillingAccumulator(todayBusiness),
      ccok: finalizeBillingAccumulator(todayCcok),
    },
  };
}

function createBillingAccumulator(pricing) {
  return {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    ordinaryInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    providers: {},
    models: {},
    days: {},
    pricing,
  };
}

function addBillingRecord(summary, normalizedRecord) {
  summary.totalRequests += 1;
  const ok = normalizedRecord.statusCode >= 200 &&
    normalizedRecord.statusCode < 400 &&
    !normalizedRecord.error;
  if (ok) summary.successRequests += 1;
  else summary.failedRequests += 1;
  addUsageTotals(summary, normalizedRecord);

  const providerKey = normalizedRecord.providerName || normalizedRecord.providerId || "未选择";
  summary.providers[providerKey] ??= emptyUsageBucket(providerKey);
  addUsageTotals(summary.providers[providerKey], normalizedRecord);
  summary.providers[providerKey].requests += 1;

  const modelKey = normalizedRecord.billingModel ||
    normalizedRecord.responseModel ||
    normalizedRecord.requestModel ||
    "unknown";
  summary.models[modelKey] ??= emptyUsageBucket(modelKey);
  addUsageTotals(summary.models[modelKey], normalizedRecord);
  summary.models[modelKey].requests += 1;
  const dayKey = normalizedRecord.dayKey;
  summary.days[dayKey] ??= emptyUsageBucket(dayKey);
  addUsageTotals(summary.days[dayKey], normalizedRecord);
  summary.days[dayKey].requests += 1;
}

function finalizeBillingAccumulator(summary) {
  return {
    ...summary,
    providers: Object.values(summary.providers).sort(compareUsageBuckets),
    models: Object.values(summary.models).sort(compareUsageBuckets),
    days: Object.values(summary.days).sort((a, b) => String(b.name).localeCompare(String(a.name))),
  };
}

function parseOptionalTime(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}


function recordId(record) {
  return String(record.id || crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex"));
}
export function createUsageQueries({ getRecords, normalizeUsageRecord, getPricing = () => ({}), now = Date.now, maxCacheEntries = 64, ttlMs = 5000 }) {
  const cache = new Map(); let hits = 0; let misses = 0;
  function cached(kind, filters, calculate, asynchronous = false) {
    const offset = clampNumber(filters.timezoneOffset, 0, -840, 840);
    const day = new Date(now() - offset * 60_000).toISOString().slice(0, 10);
    const key = JSON.stringify([kind, filters.groupId || null, filters.providerId || null, filters.startAt || null, filters.endAt || null, offset, day]);
    const previous = cache.get(key);
    if (previous && previous.expiresAt > now()) { hits++; cache.delete(key); cache.set(key, previous); return previous.value; }
    misses++;
    const item = { value: null, expiresAt: asynchronous ? Infinity : now() + ttlMs };
    const value = calculate();
    item.value = asynchronous ? Promise.resolve(value).then((result) => {
      if (cache.get(key) === item) item.expiresAt = now() + ttlMs;
      return result;
    }, (error) => { if (cache.get(key) === item) cache.delete(key); throw error; }) : value;
    cache.delete(key); cache.set(key, item);
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
    return item.value;
  }
  function matches(record, filters) {
    if (filters.groupId && usageGroupId(record) !== filters.groupId) return false;
    if (filters.providerId && record.providerId !== filters.providerId) return false;
    if (filters.status && filters.status !== "all" && String(record.statusCode) !== filters.status) return false;
    const time = Date.parse(record.timestamp || "");
    const start = parseOptionalTime(filters.startAt); const end = parseOptionalTime(filters.endAt);
    return (start === null || time >= start) && (end === null || time <= end);
  }
  return {
    summary(filters = {}) {
      return cached("summary-sync", filters, () => computeBillingSummary(getRecords(), filters, { normalizeUsageRecord, pricing: getPricing(), now }));
    },
    summaryAsync(filters = {}) {
      return cached("summary", filters, () => {
        const records = getRecords().slice(); const pricing = getPricing(); const startedAt = now();
        return computeBillingSummaryAsync(records, filters, { normalizeUsageRecord, pricing, now: () => startedAt });
      }, true);
    },
    logs(filters = {}) {
      const paged = filters.page !== undefined || filters.pageSize !== undefined;
      let records = getRecords(); let snapshot = filters.snapshot || "";
      if (paged && snapshot) {
        const boundary = records.findIndex((record) => recordId(record) === snapshot);
        if (boundary < 0) throw Object.assign(new Error("日志分页快照已经变化，请刷新第一页"), { status: 409, code: "usage_snapshot_expired" });
        records = records.slice(0, boundary + 1);
      } else if (paged) snapshot = records.length ? recordId(records.at(-1)) : "";
      const filtered = records.filter((record) => matches(record, filters));
      if (!paged) {
        const limit = Math.floor(clampNumber(filters.limit, 100, 1, 5000));
        return { groupId: filters.groupId || null, records: filtered.slice(-limit).reverse().map((record) => normalizeUsageRecord(record)), totalRecords: filtered.length, truncated: filtered.length > limit };
      }
      const pageSize = Math.floor(clampNumber(filters.pageSize, 30, 1, 200));
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.floor(clampNumber(filters.page, 1, 1, totalPages));
      const end = Math.max(0, filtered.length - (page - 1) * pageSize);
      return { groupId: filters.groupId || null, records: filtered.slice(Math.max(0, end - pageSize), end).reverse().map((record) => normalizeUsageRecord(record)),
        totalRecords: filtered.length, page, pageSize, totalPages, snapshot, truncated: false };
    },
    trend(filters = {}) {
      return cached("trend", filters, () => {
        // 保持原页面“本组最近 5000 条，再按供应商及时间过滤”的采样口径。
        const records = getRecords().filter((record) => !filters.groupId || usageGroupId(record) === filters.groupId).slice(-5000)
          .filter((record) => matches(record, { ...filters, groupId: null })).map((record) => normalizeUsageRecord(record))
          .filter((record) => !isCcokProbeUsageRecord(record) && Number.isFinite(Date.parse(record.timestamp)));
        const times = records.map((record) => Date.parse(record.timestamp));
        const first = times.length ? Math.min(...times) : 0; const last = times.length ? Math.max(...times) : 0;
        const span = Math.max(1, last - first);
        const bucketMs = span <= 7_200_000 ? 300_000 : span <= 172_800_000 ? 3_600_000 : 86_400_000;
        const buckets = new Map();
        for (const record of records) {
          const time = Math.floor(Date.parse(record.timestamp) / bucketMs) * bucketMs;
          const bucket = buckets.get(time) || { key: String(time), time, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 };
          for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]) bucket[field] += Number(record[field] || 0);
          bucket.cost += Number(record.estimatedCostUsd || 0); buckets.set(time, bucket);
        }
        return { groupId: filters.groupId || null, sampleCount: records.length, bucketMs, startAt: first || null, endAt: last || null,
          points: [...buckets.values()].sort((a, b) => a.time - b.time) };
      });
    },
    invalidate() { cache.clear(); },
    state: () => ({ entries: cache.size, hits, misses }),
  };
}
