/**
 * 代理请求错误创建、上游错误识别和失败分类模块。
 * 统一普通响应与 SSE 响应的重试语义，避免错误规则散落在服务器入口中。
 */

const NON_RETRYABLE_STATUS = new Set([400, 405, 406, 413, 414, 415, 422, 501]);
const PARALLEL_TOOL_CALLS_RULE_ID = "codex_responses_parallel_tool_calls";
const PARALLEL_TOOL_CALLS_MESSAGE =
  "X-OpenAI-Internal-Codex-Responses-Lite requires `parallel_tool_calls` to be false.";
const PAYLOAD_TOO_LARGE_RULE_ID = "provider_request_payload_too_large";
const PAYLOAD_TOO_LARGE_MESSAGE = "request payload is too large";
const RESPONSE_CONTEXT_RULE_ID = "provider_previous_response_context";

export function retryableError(
  message,
  status = 502,
  affectsCircuit = true,
  failureClass = "",
) {
  const error = new Error(message);
  error.retryable = true;
  error.status = status;
  error.affectsCircuit = affectsCircuit;
  error.failureClass = failureClass || classifyProxyFailure(error);
  return error;
}

export function nonRetryableError(message, status = 400, failureClass = "") {
  const error = new Error(message);
  error.retryable = false;
  error.status = status;
  error.affectsCircuit = false;
  error.failureClass = failureClass || classifyProxyFailure(error);
  return error;
}

export function upstreamError(
  status,
  body,
  retryable,
  affectsCircuit = true,
  failureClass = "",
) {
  const summary = body ? `HTTP ${status}: ${body}` : `HTTP ${status}`;
  const error = new Error(summary);
  error.retryable = retryable;
  error.status = status;
  error.affectsCircuit = affectsCircuit;
  error.failureClass = failureClass || classifyProxyFailure(error);
  return error;
}

/**
 * 识别已经确认属于供应商能力差异的 400，仅对明确白名单规则放行故障转移。
 */
export function detectKnownProviderCompatibilityError(
  status,
  body,
) {
  if (Number(status) !== 400) return null;
  const payload = parseJsonObject(body);
  const source = payload?.error || payload?.response?.error || payload?.failure || payload;
  const code = String(source?.code || source?.type || "").trim().toLowerCase();
  const param = String(source?.param || payload?.param || "").trim();
  const message = normalizeErrorMessage(source?.message || source?.error || payload?.message || "");
  if (
    code === "unsupported_value" &&
    param === "parallel_tool_calls" &&
    message === normalizeErrorMessage(PARALLEL_TOOL_CALLS_MESSAGE)
  ) {
    return {
      ruleId: PARALLEL_TOOL_CALLS_RULE_ID,
      failureClass: "provider_compatibility",
      retryable: true,
      affectsCircuit: false,
    };
  }
  return null;
}

/**
 * 精确识别已观察到的供应商请求大小限制。
 *
 * 本地代理自身的请求体上限仍保持不可重试；只有上游返回这条固定 413 错误时，
 * 才允许换用下一个供应商，避免把普通 4xx 错误误判为故障转移条件。
 */
export function detectKnownProviderPayloadLimitError(status, body) {
  if (Number(status) !== 413) return null;
  const payload = parseJsonObject(body);
  const source = payload?.error || payload?.response?.error || payload?.failure || payload;
  const message = normalizeErrorMessage(source?.message || source?.error || payload?.message || "");
  if (message.toLowerCase() !== PAYLOAD_TOO_LARGE_MESSAGE) return null;
  return {
    ruleId: PAYLOAD_TOO_LARGE_RULE_ID,
    failureClass: "provider_payload_limit",
    retryable: true,
    affectsCircuit: false,
  };
}

/**
 * 识别供应商明确表示 previous_response_id 不属于当前上下文的错误。
 *
 * 这类错误不代表供应商故障；价格优先切换时，旧响应 ID 可能只在原供应商
 * 有效。识别后允许本次请求顺序回退到原供应商，但不计入供应商断路器。
 */
export function detectKnownResponseContextError(status, body) {
  const numericStatus = Number(status);
  if (![400, 404, 422].includes(numericStatus)) return null;
  const payload = parseJsonObject(body);
  const source = payload?.error || payload?.response?.error || payload?.failure || payload;
  const code = String(source?.code || source?.type || payload?.code || "").toLowerCase();
  const message = normalizeErrorMessage(source?.message || source?.error || payload?.message || body);
  const text = `${code} ${message}`.toLowerCase();
  const hasResponseReference =
    /previous[\s_-]*response(?:[\s_-]*id)?/.test(text) ||
    /response[\s_-]*id/.test(text) ||
    /response\s+with\s+id/.test(text) ||
    /no response with id/.test(text);
  // 不把通用的 invalid_request_error 代码误认为响应上下文失配；必须有
  // “不存在/不属于当前上下文”等语义，或明确说 response_id 无效。
  const hasMissingOrOwnershipError =
    /not[\s_-]*found/.test(text) ||
    /does not exist/.test(text) ||
    /unknown/.test(text) ||
    /not belong/.test(text) ||
    /belongs to (?:a|another)/.test(text) ||
    /not available/.test(text) ||
    /(?:previous[\s_-]*response|response)[\s_-]*id[^\n]{0,80}\b(?:is|was|:)?\s*invalid\b/.test(
      message.toLowerCase(),
    );
  if (!hasResponseReference || !hasMissingOrOwnershipError) return null;
  return {
    ruleId: RESPONSE_CONTEXT_RULE_ID,
    failureClass: "response_context_incompatible",
    retryable: true,
    affectsCircuit: false,
  };
}

/**
 * SSE 结构化错误使用已解析字段匹配同一条兼容性规则，避免重复维护字符串判断。
 */
export function detectKnownProviderCompatibilityFields({ status, code, param, message }) {
  if (Number(status) !== 400) return null;
  if (
    String(code || "").trim().toLowerCase() === "unsupported_value" &&
    String(param || "").trim() === "parallel_tool_calls" &&
    normalizeErrorMessage(message) === normalizeErrorMessage(PARALLEL_TOOL_CALLS_MESSAGE)
  ) {
    return {
      ruleId: PARALLEL_TOOL_CALLS_RULE_ID,
      failureClass: "provider_compatibility",
      retryable: true,
      affectsCircuit: false,
    };
  }
  return null;
}

/** SSE 结构化错误的 previous_response_id 兼容性识别。 */
export function detectKnownResponseContextFields({ status, code, param, message }) {
  const numericStatus = Number(status);
  if (![400, 404, 422].includes(numericStatus)) return null;
  const text = `${String(code || "")} ${String(param || "")} ${String(message || "")}`.toLowerCase();
  const hasResponseReference =
    /previous[\s_-]*response(?:[\s_-]*id)?/.test(text) ||
    /response[\s_-]*id/.test(text) ||
    /response\s+with\s+id/.test(text) ||
    /no response with id/.test(text);
  const hasMissingOrOwnershipError =
    /not[\s_-]*found/.test(text) ||
    /does not exist/.test(text) ||
    /unknown/.test(text) ||
    /not belong/.test(text) ||
    /belongs to (?:a|another)/.test(text) ||
    /not available/.test(text) ||
    /(?:previous[\s_-]*response|response)[\s_-]*id[^\n]{0,80}\b(?:is|was|:)?\s*invalid\b/.test(
      String(message || "").toLowerCase(),
    );
  if (!hasResponseReference || !hasMissingOrOwnershipError) return null;
  return {
    ruleId: RESPONSE_CONTEXT_RULE_ID,
    failureClass: "response_context_incompatible",
    retryable: true,
    affectsCircuit: false,
  };
}

export function classifyProxyFailure(error) {
  if (!error) return "unknown";
  if (error.failureClass) return String(error.failureClass);
  const status = Number(error.status || 0);
  const message = String(error.message || error || "");
  const lower = message.toLowerCase();
  if (isUnsupportedModelText(message)) return "model_unsupported";
  if (status === 401 || status === 403 || lower.includes("invalid_api_key")) {
    return "authentication";
  }
  if (status === 429 || lower.includes("rate_limit") || lower.includes("too many requests")) {
    return "rate_limited";
  }
  if (lower.includes("sse 前导") || lower.includes("sse 格式")) {
    return "stream_protocol";
  }
  if (isCapacityText(message)) return "capacity";
  if (
    lower.includes("连接上游失败") ||
    lower.includes("流式响应超时") ||
    lower.includes("请求超时或被中断") ||
    lower.includes("读取上游响应失败") ||
    lower.includes("error decoding response body") ||
    lower.includes("network error") ||
    lower.includes("fetch failed") ||
    lower.includes("terminated") ||
    lower.includes("econnreset") ||
    lower.includes("connection reset") ||
    lower.includes("other side closed")
  ) {
    return "transport";
  }
  if (status >= 500) return "upstream_5xx";
  if (status === 400 || status === 422) return "invalid_request";
  if (error.affectsCircuit === false) return "proxy_local";
  return "unknown";
}

export function isRetryableStatus(status) {
  return !NON_RETRYABLE_STATUS.has(status);
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeErrorMessage(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function isUnsupportedModelText(text) {
  const lower = String(text || "").toLowerCase();
  return lower.includes("model_not_found") ||
    lower.includes("model not found") ||
    lower.includes("no available channel for model") ||
    (lower.includes("model") && lower.includes("is not available for")) ||
    lower.includes("does not support") ||
    lower.includes("unsupported model") ||
    lower.includes("unknown model");
}

export function isCapacityText(text) {
  const lower = String(text || "").toLowerCase();
  return lower.includes("at capacity") ||
    lower.includes("overloaded") ||
    lower.includes("model_not_available");
}

export function formatFetchError(error) {
  if (error?.name === "AbortError") return "请求超时或被中断";
  const message = error instanceof Error ? error.message : String(error);
  const cause = error?.cause?.message ? String(error.cause.message) : "";
  return cause && !message.includes(cause) ? `${message}: ${cause}` : message;
}

export function detectUpstreamPayloadError(text) {
  const raw = String(text || "").slice(0, 12000);
  if (!raw.trim()) return null;

  for (const payload of collectJsonPayloads(raw)) {
    const detected = detectErrorFromPayload(payload);
    if (detected) return detected;
  }
  return detectErrorFromText(raw);
}

function detectErrorFromText(text) {
  const lower = text.toLowerCase();
  if (
    lower.includes("exceeded retry limit") &&
    (lower.includes("429") || lower.includes("too many requests"))
  ) {
    return {
      status: 429,
      retryable: true,
      message: extractErrorMessage(text) || "exceeded retry limit, last status: 429 Too Many Requests",
    };
  }
  if (
    lower.includes("too many requests") &&
    (lower.includes("\"error\"") || lower.includes("data:") || lower.includes("status"))
  ) {
    return {
      status: 429,
      retryable: true,
      message: extractErrorMessage(text) || "429 Too Many Requests",
    };
  }
  return null;
}

function collectJsonPayloads(text) {
  const payloads = [];
  pushJsonTextCandidate(payloads, text.trim());
  for (const line of text.split("\n")) {
    const item = line.trim();
    if (!item.startsWith("data:")) continue;
    const data = item.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    pushJsonTextCandidate(payloads, data);
  }
  return payloads;
}

function detectErrorFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const direct = payload.error || payload.response?.error || payload.failure || null;
  if (direct) {
    const status = Number(direct.status || direct.statusCode || direct.code);
    const message = String(direct.message || direct.error || direct.code || "");
    const code = String(direct.code || direct.type || payload.type || "").toLowerCase();
    const messageLC = message.toLowerCase();
    if (
      status === 401 ||
      status === 403 ||
      code.includes("auth") ||
      code.includes("invalid_api_key") ||
      messageLC.includes("failed to validate api key")
    ) {
      return { status: status || 401, retryable: true, message: message || "API Key 验证失败" };
    }
    if (status === 429 || code.includes("rate_limit") || code.includes("too_many_requests")) {
      return {
        status: 429,
        retryable: true,
        message: message || "429 Too Many Requests",
      };
    }
    if (
      messageLC.includes("at capacity") ||
      messageLC.includes("overloaded") ||
      code.includes("capacity") ||
      code.includes("overload") ||
      code.includes("model_not_available")
    ) {
      return { status: 503, retryable: true, message: message || "Model at capacity" };
    }
    if (status >= 500) {
      return { status, retryable: true, message: message || `HTTP ${status}` };
    }
  }

  const status = Number(payload.statusCode || payload.status);
  if (status === 429) {
    return {
      status: 429,
      retryable: true,
      message: String(payload.message || "429 Too Many Requests"),
    };
  }
  if (payload.response && typeof payload.response === "object") {
    return detectErrorFromPayload(payload.response);
  }
  return null;
}

function extractErrorMessage(text) {
  const match = String(text || "").match(/(?:message|error)["']?\s*[:=]\s*["']([^"']{1,500})/i);
  return match?.[1] || "";
}

function pushJsonTextCandidate(candidates, text) {
  try {
    candidates.push(JSON.parse(text));
  } catch {}
}
