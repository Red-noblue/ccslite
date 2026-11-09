/**
 * 价格实验核心计算测试。
 * 验证账面扣费折算、缓存 Token 归一化和四类有效价格拟合。
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.LITE_CCSWITCH_SKIP_BOOTSTRAP = "1";
const {
  calculateActualCost,
  calculateUsageCost,
  fitEffectivePrices,
  normalizeRawUsage,
} = await import("../../server.js");

test("账面扣费按分子除以分母折算为实际现金成本", () => {
  assert.equal(calculateActualCost(2, 80, 100), 1.6);
  assert.equal(calculateActualCost(2, 1.5, 1), 3);
  assert.equal(calculateActualCost(2, 1, 1), 2);
});

test("OpenAI usage 中缓存 Token 是总输入的明细", () => {
  const usage = normalizeRawUsage({
    input_tokens: 1000,
    output_tokens: 40,
    total_tokens: 1040,
    input_tokens_details: {
      cached_tokens: 700,
      cache_write_tokens: 200,
    },
  });
  assert.equal(usage.usageFormat, "openai_responses");
  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.ordinaryInputTokens, 100);
  assert.equal(usage.cacheReadTokens, 700);
  assert.equal(usage.cacheCreationTokens, 200);
});

test("Anthropic usage 中三类输入 Token 分别累加为逻辑输入", () => {
  const usage = normalizeRawUsage({
    input_tokens: 100,
    output_tokens: 40,
    cache_read_input_tokens: 700,
    cache_creation_input_tokens: 200,
  });
  assert.equal(usage.usageFormat, "anthropic");
  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.ordinaryInputTokens, 100);
  assert.equal(usage.cacheReadTokens, 700);
  assert.equal(usage.cacheCreationTokens, 200);
});

test("独立样本可以拟合四类非负有效价格", () => {
  const expectedRates = {
    inputPerMillion: 2,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.2,
    cacheCreationPerMillion: 2.5,
  };
  const vectors = [
    [1000, 10, 0, 0],
    [2000, 10, 0, 0],
    [100, 1000, 0, 0],
    [100, 10, 5000, 0],
    [100, 10, 0, 5000],
    [2500, 700, 3000, 4000],
  ];
  const equations = vectors.map((tokens, index) => ({
    tokens,
    actualCost: calculateUsageCost({
      ordinaryInputTokens: tokens[0],
      outputTokens: tokens[1],
      cacheReadTokens: tokens[2],
      cacheCreationTokens: tokens[3],
    }, expectedRates),
    kind: ["input_short", "input_long", "output_long", "cache_read", "cache_write", "long_term"][index],
  }));
  const fitted = fitEffectivePrices(equations);
  assert.equal(fitted.status, "stable");
  for (const [name, expected] of Object.entries(expectedRates)) {
    assert.ok(Math.abs(fitted.rates[name] - expected) < 1e-6, `${name} 应拟合为 ${expected}`);
  }
});
