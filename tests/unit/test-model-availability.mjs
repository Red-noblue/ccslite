/**
 * 模型可用性证据与失败分类测试。
 *
 * 验证模型支持结论会按时效失效，并确保模型错误、SSE 兼容问题等不会混入供应商健康判断。
 */

import assert from "node:assert/strict";
import test from "node:test";

process.env.LITE_CCSWITCH_SKIP_BOOTSTRAP = "1";
const {
  applyManualModelSupport,
  classifyProxyFailure,
  detectKnownProviderCompatibilityError,
  getModelAvailability,
  getProviderTestModels,
  isUnsupportedModelResult,
  normalizeConnectivityCandidateModels,
  normalizeModelSupport,
  orderProvidersForModel,
  preferredProviderRetryDelay,
  rememberProviderModelEvidence,
  shouldTryNextProviderTestModel,
} = await import("../../server.js");

const NOW_MS = Date.parse("2026-08-07T06:00:00.000Z");

test("旧模型列表会迁移为带有效期的证据", () => {
  const support = normalizeModelSupport({
    preferredTestModel: "gpt-5.6-terra",
    supportedModels: ["gpt-5.6-sol"],
    unsupportedModels: ["gpt-5.6-luna"],
    lastTestedAt: "2026-08-07T05:50:00.000Z",
  }, NOW_MS);

  assert.equal(support.modelEvidence["gpt-5.6-sol"].state, "supported");
  assert.equal(support.modelEvidence["gpt-5.6-luna"].state, "unsupported");
  assert.equal(
    getModelAvailability({ modelSupport: support }, "gpt-5.6-luna", NOW_MS).state,
    "unsupported",
  );
  assert.equal(
    getModelAvailability({ modelSupport: support }, "gpt-5.6-luna", NOW_MS + 31 * 60_000).state,
    "unknown",
  );
  assert.equal(
    getModelAvailability({ modelSupport: support }, "gpt-5.6-sol", NOW_MS + 31 * 60_000).state,
    "supported",
  );

  const futureLegacy = normalizeModelSupport({
    supportedModels: ["gpt-5.6-sol"],
    lastTestedAt: "2026-08-07T13:50:00.000Z",
  }, NOW_MS);
  assert.equal(futureLegacy.modelEvidence["gpt-5.6-sol"].checkedAt, new Date(NOW_MS).toISOString());
});

test("实际请求证据可以在临时不支持到期后恢复模型", () => {
  const provider = { modelSupport: {} };
  assert.equal(
    rememberProviderModelEvidence(
      provider,
      "gpt-5.6-sol",
      "unsupported",
      "upstream_error",
      "model_unsupported",
      NOW_MS,
    ),
    true,
  );
  assert.equal(getModelAvailability(provider, "gpt-5.6-sol", NOW_MS).state, "unsupported");
  assert.equal(
    getModelAvailability(provider, "gpt-5.6-sol", NOW_MS + 31 * 60_000).state,
    "unknown",
  );

  assert.equal(
    rememberProviderModelEvidence(
      provider,
      "gpt-5.6-sol",
      "supported",
      "actual_request",
      "request_succeeded",
      NOW_MS + 31 * 60_000,
    ),
    true,
  );
  assert.equal(
    getModelAvailability(provider, "gpt-5.6-sol", NOW_MS + 31 * 60_000).state,
    "supported",
  );
});

test("路由始终服从手动优先级，并只临时跳过明确不支持项", () => {
  const providers = [
    {
      id: "unsupported",
      name: "临时不支持",
      sortIndex: 1,
      modelSupport: {
        modelEvidence: {
          "gpt-5.6-sol": {
            state: "unsupported",
            source: "upstream_error",
            checkedAt: new Date(NOW_MS).toISOString(),
            expiresAt: new Date(NOW_MS + 30 * 60_000).toISOString(),
          },
        },
      },
    },
    { id: "unknown", name: "未知", sortIndex: 2, modelSupport: {} },
    {
      id: "supported",
      name: "已支持",
      sortIndex: 3,
      modelSupport: {
        modelEvidence: {
          "gpt-5.6-sol": {
            state: "supported",
            source: "actual_request",
            checkedAt: new Date(NOW_MS).toISOString(),
            expiresAt: new Date(NOW_MS + 6 * 60 * 60_000).toISOString(),
          },
        },
      },
    },
  ];

  assert.deepEqual(
    orderProvidersForModel(providers, "gpt-5.6-sol", NOW_MS).map((provider) => provider.id),
    ["unknown", "supported"],
  );
  assert.deepEqual(
    orderProvidersForModel(
      providers,
      "gpt-5.6-sol",
      NOW_MS + 31 * 60_000,
    ).map((provider) => provider.id),
    ["unsupported", "unknown", "supported"],
  );
});

test("失败分类不会把模型或本地 SSE 问题伪装成供应商故障", () => {
  assert.equal(
    classifyProxyFailure({ status: 404, message: "model_not_found", affectsCircuit: false }),
    "model_unsupported",
  );
  assert.equal(
    classifyProxyFailure({ status: 503, message: "servers overloaded", affectsCircuit: true }),
    "capacity",
  );
  assert.equal(
    classifyProxyFailure({ message: "SSE 前导数据超过限制", affectsCircuit: false }),
    "stream_protocol",
  );
  assert.equal(
    classifyProxyFailure({ failureClass: "client_cancelled", message: "请求超时或被中断" }),
    "client_cancelled",
  );
});

test("仅对明确的 parallel_tool_calls 供应商兼容错误允许故障转移", () => {
  const body = JSON.stringify({
    error: {
      code: "unsupported_value",
      param: "parallel_tool_calls",
      message: "X-OpenAI-Internal-Codex-Responses-Lite requires `parallel_tool_calls` to be false.",
    },
  });
  assert.deepEqual(
    detectKnownProviderCompatibilityError(400, body),
    {
      ruleId: "codex_responses_parallel_tool_calls",
      failureClass: "provider_compatibility",
      retryable: true,
      affectsCircuit: false,
    },
  );
  assert.equal(
    detectKnownProviderCompatibilityError(400, JSON.stringify({
      error: { code: "invalid_request_error", message: "参数错误" },
    })),
    null,
  );
  assert.equal(
    detectKnownProviderCompatibilityError(400, JSON.stringify({
      error: {
        code: "unsupported_value",
        param: "parallel_tool_calls",
        message: "requires parallel_tool_calls to be false (request id: abc)",
      },
    })),
    null,
  );
});

test("模型前缀不支持会继续尝试下一个连通性测试模型", () => {
  const result = {
    status: 404,
    message: "model gpt-5.6-luna is not available for /codex prefix",
  };
  assert.equal(isUnsupportedModelResult(result), true);
  assert.equal(shouldTryNextProviderTestModel(result, 1, 3), true);
  assert.equal(shouldTryNextProviderTestModel(result, 3, 3), false);
});

test("模型响应不匹配会被视为当前模型不支持", () => {
  const result = {
    status: 200,
    failureClass: "model_unsupported",
    message: "模型响应模型不匹配：请求 gpt-6-astra，实际 gpt-5.6-luna",
  };
  assert.equal(isUnsupportedModelResult(result), true);
  assert.equal(shouldTryNextProviderTestModel(result, 1, 2), true);
});

test("首选模型失败后先升级到更高档测试模型", () => {
  assert.deepEqual(
    getProviderTestModels({
      modelSupport: {
        preferredTestModel: "gpt-5.6-terra",
      },
    }),
    ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"],
  );
});

test("手动模型状态按时效生效，并跳过临时不支持模型", () => {
  const support = applyManualModelSupport({}, {
    preferredTestModel: "gpt-5.6-sol",
    supportedModels: ["gpt-5.6-sol"],
    unsupportedModels: ["gpt-5.6-luna", "gpt-5.6-terra"],
  }, NOW_MS);
  const provider = { modelSupport: support };

  assert.equal(getModelAvailability(provider, "gpt-5.6-sol", NOW_MS).state, "supported");
  assert.equal(getModelAvailability(provider, "gpt-5.6-luna", NOW_MS).state, "unsupported");
  assert.deepEqual(getProviderTestModels(provider, NOW_MS), ["gpt-5.6-sol"]);
  assert.equal(
    getModelAvailability(provider, "gpt-5.6-luna", NOW_MS + 31 * 60_000).state,
    "unknown",
  );
});

test("连通性测试遇到短暂故障会换模型，鉴权错误不会", () => {
  assert.equal(
    shouldTryNextProviderTestModel({ status: 0, message: "请求超时或被中断" }, 1, 3),
    true,
  );
  assert.equal(
    shouldTryNextProviderTestModel({ status: 522, message: "Connection timed out" }, 1, 3),
    true,
  );
  assert.equal(
    shouldTryNextProviderTestModel({ status: 401, message: "invalid_api_key" }, 1, 3),
    false,
  );
});

test("连通性候选模型会去重并拒绝空列表", () => {
  assert.deepEqual(
    normalizeConnectivityCandidateModels(
      ["gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol"],
      ["gpt-5.6-luna"],
    ),
    ["gpt-5.6-terra", "gpt-5.6-sol"],
  );
  assert.deepEqual(
    normalizeConnectivityCandidateModels([], ["gpt-5.6-luna"]),
    ["gpt-5.6-luna"],
  );
});

test("首选供应商只对短暂故障等待重试，超出预算后立即让出优先级", () => {
  const proxyConfig = {
    preferredProviderRetryDelayMs: 2_000,
    preferredProviderRetryMaxDelayMs: 5_000,
    preferredProviderRetryBudgetMs: 20_000,
  };
  assert.equal(preferredProviderRetryDelay({
    providerIndex: 0,
    providerAttempt: 1,
    providerAttemptLimit: 3,
    failureClass: "authentication",
    providerElapsedMs: 10,
    proxyConfig,
  }), 2_000);
  assert.equal(preferredProviderRetryDelay({
    providerIndex: 0,
    providerAttempt: 2,
    providerAttemptLimit: 3,
    failureClass: "upstream_5xx",
    providerElapsedMs: 10,
    proxyConfig,
  }), 4_000);
  assert.equal(preferredProviderRetryDelay({
    providerIndex: 0,
    providerAttempt: 1,
    providerAttemptLimit: 3,
    failureClass: "transport",
    providerElapsedMs: 19_000,
    proxyConfig,
  }), 0);
  assert.equal(preferredProviderRetryDelay({
    providerIndex: 0,
    providerAttempt: 1,
    providerAttemptLimit: 3,
    failureClass: "stream_progress_timeout",
    providerElapsedMs: 10,
    proxyConfig,
  }), 2_000);
  assert.equal(preferredProviderRetryDelay({
    providerIndex: 1,
    providerAttempt: 1,
    providerAttemptLimit: 1,
    failureClass: "upstream_5xx",
    providerElapsedMs: 10,
    proxyConfig,
  }), 0);
});
