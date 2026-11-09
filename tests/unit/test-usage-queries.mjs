/** 中文用量查询验收：稳定分页、完整汇总、缓存失效、香港跨午夜及有界缓存。 */
import assert from "node:assert/strict";
import test from "node:test";
import { createUsageQueries, computeBillingSummary } from "../../lib/usage-queries.js";
import { normalizeUsageRecord } from "../../lib/usage-records.js";
const row = (i, overrides = {}) => ({ id: `r-${i}`, groupId: "default", providerId: "p", providerName: "供应商", statusCode: 200,
  timestamp: "2026-11-09T10:00:00Z", inputTokens: 2, outputTokens: 3, totalTokens: 5, estimatedCostUsd: 0.01, ...overrides });
test("新增记录不会改变旧快照的后续分页，服务端先过滤再分页，兼容 limit", () => {
  const records = Array.from({ length: 65 }, (_, i) => row(i));
  const queries = createUsageQueries({ getRecords: () => records, normalizeUsageRecord });
  const first = queries.logs({ page: "1", pageSize: "30", groupId: "default" });
  records.push(row(65));
  const second = queries.logs({ page: "2", pageSize: "30", groupId: "default", snapshot: first.snapshot });
  assert.equal(first.records[0].id, "r-64"); assert.equal(second.records[0].id, "r-34");
  assert.equal(new Set([...first.records, ...second.records].map((item) => item.id)).size, 60);
  records.push(row(66, { statusCode: 403 })); records.push(row(67, { groupId: "other", statusCode: 403 }));
  assert.equal(queries.logs({ page: "1", status: "403", groupId: "default" }).totalRecords, 1);
  assert.equal(queries.logs({ limit: "2" }).records.length, 2);
  assert.throws(() => queries.logs({ page: "1", snapshot: "missing" }), { code: "usage_snapshot_expired" });
});
test("缓存包含日期和时区，香港跨午夜、价格变化及新用量后立即正确", () => {
  let time = Date.parse("2026-11-09T15:59:59Z");
  const records = [row(1, { timestamp: "2026-11-09T15:00:00Z" })];
  const queries = createUsageQueries({ getRecords: () => records, normalizeUsageRecord, now: () => time, maxCacheEntries: 2 });
  assert.equal(queries.summary({ timezoneOffset: -480 }).today.totalTokens, 5);
  assert.deepEqual(queries.summary({ timezoneOffset: -480 }), computeBillingSummary(records, { timezoneOffset: -480 }, { normalizeUsageRecord, now: () => time }));
  assert.equal(queries.state().hits, 1);
  time += 2000; assert.equal(queries.summary({ timezoneOffset: -480 }).today.totalTokens, 0);
  records.push(row(2, { timestamp: "2026-11-09T16:00:00Z" })); queries.invalidate();
  assert.equal(queries.summary({ timezoneOffset: -480 }).today.totalTokens, 5);
  for (let i = 0; i < 10; i++) queries.summary({ providerId: String(i) });
  assert.equal(queries.state().entries, 2);
  queries.invalidate(); assert.equal(queries.state().entries, 0);
});
test("汇总覆盖完整历史，趋势采样与分页独立，重复查询避免重新归一化", () => {
  const records = Array.from({ length: 50_000 }, (_, i) => row(i, { usageCategory: i % 10 === 0 ? "ccok_probe" : "" }));
  let normalizations = 0;
  const queries = createUsageQueries({ getRecords: () => records, normalizeUsageRecord: (record) => { normalizations++; return normalizeUsageRecord(record); } });
  const first = queries.summary({ groupId: "default" });
  assert.equal(first.totalTokens, 250_000); assert.equal(first.business.totalRequests, 45_000); assert.equal(first.ccok.totalRequests, 5000);
  queries.summary({ groupId: "default" }); assert.equal(normalizations, 50_000);
  const trend = queries.trend({ groupId: "default" }); assert.equal(trend.sampleCount, 4500);
  assert.equal(trend.points.reduce((sum, point) => sum + point.outputTokens, 0), 13_500);
});

test("冷汇总让出事件循环、合并并发查询，并保持请求开始时的日期与定价快照", async () => {
  const records = Array.from({ length: 20_000 }, (_, i) => row(i));
  let time = Date.parse("2026-11-09T15:59:59Z"); let pricing = { rate: 1 }; let turns = 0;
  const normalizer = (record, snapshot = pricing) => ({ ...normalizeUsageRecord(record), estimatedCostUsd: snapshot.rate });
  const queries = createUsageQueries({ getRecords: () => records, getPricing: () => pricing, normalizeUsageRecord: normalizer, now: () => time });
  const pending = queries.summaryAsync({ timezoneOffset: -480 });
  assert.equal(queries.summaryAsync({ timezoneOffset: -480 }), pending);
  await new Promise((resolve) => setImmediate(() => { turns++; time += 2000; pricing = { rate: 3 }; records.push(row(20_000)); queries.invalidate(); resolve(); }));
  const summary = await pending;
  assert.equal(turns, 1); assert.equal(summary.totalRequests, 20_000); assert.equal(summary.today.totalRequests, 20_000);
  assert.equal(summary.estimatedCostUsd, 20_000); assert.equal(queries.state().entries, 0);
  const next = await queries.summaryAsync({ timezoneOffset: -480 });
  assert.equal(next.totalRequests, 20_001); assert.equal(next.today.totalRequests, 0); assert.equal(next.estimatedCostUsd, 60_003);
});
