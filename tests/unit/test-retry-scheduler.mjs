/**
 * 交错重试计划测试。
 * 确保单业务请求不会并行复制，同时满足首选 6 次、其他供应商 2 次和总上限。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildInterleavedAttemptPlan } from "../../lib/retry-scheduler.js";

test("两个供应商先给首选两个槽位，再给后续供应商两个槽位", () => {
  assert.deepEqual(
    buildInterleavedAttemptPlan(2, { preferredAttempts: 6, providerAttempts: 2, maxAttempts: 30 }),
    [0, 0, 1, 1, 0, 0, 0, 0],
  );
});

test("总尝试数受 maxAttempts 限制", () => {
  const plan = buildInterleavedAttemptPlan(20, {
    preferredAttempts: 6,
    providerAttempts: 2,
    maxAttempts: 5,
  });
  assert.equal(plan.length, 5);
  assert.equal(new Set(plan).has(1), true);
});

test("总尝试数不会超过系统上限 30 次", () => {
  const plan = buildInterleavedAttemptPlan(40, {
    preferredAttempts: 20,
    providerAttempts: 20,
    maxAttempts: 100,
  });
  assert.equal(plan.length, 30);
});
