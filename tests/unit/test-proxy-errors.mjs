/**
 * 代理错误兼容规则测试。
 * 仅对明确的 previous_response_id 上下文失配允许顺序回退，不放宽普通 4xx。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProxyFailure,
  detectKnownResponseContextError,
  detectKnownResponseContextFields,
  formatFetchError,
} from "../../lib/proxy-errors.js";

test("明确的 previous_response_id 失配允许回退且不进入断路器", () => {
  const detected = detectKnownResponseContextError(400, JSON.stringify({
    error: {
      code: "invalid_request_error",
      param: "previous_response_id",
      message: "previous_response_id resp_old does not belong to this provider",
    },
  }));
  assert.deepEqual(detected, {
    ruleId: "provider_previous_response_context",
    failureClass: "response_context_incompatible",
    retryable: true,
    affectsCircuit: false,
  });
});

test("普通 previous_response_id 参数错误不会误触发上下文回退规则", () => {
  assert.equal(
    detectKnownResponseContextError(400, JSON.stringify({
      error: {
        code: "invalid_request_error",
        param: "previous_response_id",
        message: "previous_response_id 格式错误",
      },
    })),
    null,
  );
});

test("SSE 结构化上下文错误使用同一条白名单规则", () => {
  assert.deepEqual(
    detectKnownResponseContextFields({
      status: 404,
      code: "response_not_found",
      param: "previous_response_id",
      message: "response_id resp_old not found",
    }),
    {
      ruleId: "provider_previous_response_context",
      failureClass: "response_context_incompatible",
      retryable: true,
      affectsCircuit: false,
    },
  );
});

test("识别 response with id 形式的上游错误", () => {
  const detected = detectKnownResponseContextError(
    404,
    JSON.stringify({ error: { message: "The response with id resp_old was not found" } }),
  );
  assert.equal(detected?.failureClass, "response_context_incompatible");
});

test("上游响应体解码或网络断开归类为可重试传输故障", () => {
  const error = new Error("terminated");
  error.cause = new Error("error decoding response body");
  const message = formatFetchError(error);

  assert.match(message, /terminated: error decoding response body/);
  assert.equal(classifyProxyFailure({ message }), "transport");
  assert.equal(classifyProxyFailure({ message: "network error: other side closed" }), "transport");
});
