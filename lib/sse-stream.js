/**
 * SSE 事件解析、前导探测和流式转发模块。
 * 仅通过参数接收超时、计费解析和错误日志回调，不持有服务器全局状态。
 */

import { StringDecoder } from "node:string_decoder";
import { DEFAULT_STREAM_POLICY } from "./stream-policy.js";
import {
  classifyProxyFailure,
  detectKnownProviderCompatibilityFields,
  detectKnownResponseContextFields,
  formatFetchError,
  isCapacityText,
  isUnsupportedModelText,
  nonRetryableError,
  retryableError,
  upstreamError,
} from "./proxy-errors.js";

const SSE_PREAMBLE_LIMIT = 64 * 1024;

function isoTime(value) {
  return value ? new Date(value).toISOString() : null;
}

export async function readFirstChunk(reader, timeoutMs, controller) {
  try {
    const first = await readWithTimeout(reader, timeoutMs, controller);
    if (first.done) {
      throw retryableError("流式响应在首包到达前结束");
    }
    return first.value;
  } catch (error) {
    if (error.retryable) throw error;
    throw retryableError(`流式响应首包失败: ${error.message}`);
  }
}

export function createSseInspector() {
  return new SseInspector();
}

export function buildSseDiagnostics(sseInspector, preambleBytes, probeOutcome) {
  return {
    preambleBytes: Math.max(0, Number(preambleBytes || 0)),
    probeOutcome: String(probeOutcome || ""),
    events: sseInspector?.summary?.() || {
      totalEvents: 0,
      validatedEvents: 0,
      unparsedEvents: 0,
      semanticStarted: false,
      completed: false,
      eventTypes: {},
    },
  };
}

export function attachStreamDiagnostics(error, diagnostics) {
  if (error && !error.streamDiagnostics) {
    error.streamDiagnostics = diagnostics;
  }
  return error;
}

export async function probeSseStream(reader, firstChunkValue, idleTimeoutMs, controller, onChunk = () => {}, { progressTimeoutMs = 0 } = {}) {
  let preamble = Buffer.from(firstChunkValue);
  const sseInspector = createSseInspector();
  let inspection = sseInspector.feed(firstChunkValue);
  onChunk(preamble.length, { state: "probing", semanticStarted: inspection.semantic, progress: inspection.progress, completed: inspection.completed });
  if (inspection.error) {
    controller.abort();
    throw attachStreamDiagnostics(
      upstreamError(
        inspection.error.status,
        inspection.error.message,
        inspection.error.retryable,
        inspection.error.affectsCircuit !== false,
        inspection.error.failureClass || "",
      ),
      buildSseDiagnostics(sseInspector, preamble.length, "structured_error"),
    );
  }
  if (
    inspection.semantic ||
    inspection.completed ||
    inspection.validatedEvents > 0
  ) {
    return {
      preamble,
      sseInspector,
      sseDiagnostics: buildSseDiagnostics(
        sseInspector,
        preamble.length,
        inspection.semantic ? "semantic" : inspection.completed ? "completed" : "validated_events",
      ),
    };
  }

  let reachedEnd = false;
  while (preamble.length < SSE_PREAMBLE_LIMIT) {
    let next;
    try {
      next = await readNextChunk(reader, idleTimeoutMs, controller, progressDeadline(sseInspector, progressTimeoutMs));
    } catch (error) {
      throw attachStreamDiagnostics(error, {
        ...buildSseDiagnostics(sseInspector, preamble.length, "probe_error"),
        termination: error.failureClass === "stream_progress_timeout" ? "upstream_progress_timeout" : /超时/.test(error.message) ? "upstream_idle_timeout" : "stream_error",
        outputStarted: false,
        progressTimeoutMs,
        lastProgressAt: isoTime(sseInspector.lastProgressAtMs),
      });
    }
    if (next.done) {
      reachedEnd = true;
      break;
    }
    const nextBuf = Buffer.from(next.value);
    preamble = Buffer.concat([preamble, nextBuf]);
    inspection = sseInspector.feed(nextBuf);
    onChunk(nextBuf.length, { state: "probing", semanticStarted: inspection.semantic, progress: inspection.progress, completed: inspection.completed });
    if (inspection.error) {
      controller.abort();
      throw attachStreamDiagnostics(
        upstreamError(
          inspection.error.status,
          inspection.error.message,
          inspection.error.retryable,
          inspection.error.affectsCircuit !== false,
          inspection.error.failureClass || "",
        ),
        buildSseDiagnostics(sseInspector, preamble.length, "structured_error"),
      );
    }
    if (
      inspection.semantic ||
      inspection.completed ||
      inspection.validatedEvents > 0
    ) break;
  }

  if (
    !inspection.semantic &&
    !inspection.completed &&
    inspection.validatedEvents === 0
  ) {
    controller.abort();
    const message = reachedEnd
      ? "流式响应在首个有效输出或终止事件前关闭"
      : `SSE 前导数据超过限制: ${SSE_PREAMBLE_LIMIT} bytes`;
    throw attachStreamDiagnostics(
      retryableError(message, 502, false, "stream_protocol"),
      buildSseDiagnostics(
        sseInspector,
        preamble.length,
        reachedEnd ? "closed_before_validation" : "preamble_limit",
      ),
    );
  }

  return {
    preamble,
    sseInspector,
    sseDiagnostics: buildSseDiagnostics(sseInspector, preamble.length, "validated_events"),
  };
}

export async function pipeSseReadableStream(
  res,
  reader,
  controller,
  firstChunk,
  sseInspector,
  probeDiagnostics,
  {
    idleTimeoutMs = 0,
    progressTimeoutMs = 0,
    onStart = () => {},
    onError = () => {},
    onChunk = () => {},
    extractUsage = () => ({}),
    deferUntilSemantic = false,
    deferredBufferLimit = DEFAULT_STREAM_POLICY.streamingDeferredBufferBytes,
    deferredOutputGraceMs = DEFAULT_STREAM_POLICY.streamingDeferredOutputGraceMs,
  } = {},
) {
  let completed = false;
  let clientClosed = false;
  const currentInspector = sseInspector || createSseInspector();
  if (!sseInspector && firstChunk?.length) currentInspector.feed(firstChunk);
  const firstObservedAtMs = currentInspector.firstChunkAtMs;
  let lastObservedAtMs = currentInspector.lastChunkAtMs;
  const deferredDeadlineMs = (firstObservedAtMs ?? Date.now()) + deferredOutputGraceMs;
  const diagnostics = {
    ...(probeDiagnostics || {}),
    forwardedBytes: 0,
    forwardedChunks: 0,
    firstByteAt: isoTime(firstObservedAtMs),
    lastChunkAt: isoTime(firstObservedAtMs),
    firstForwardedAt: null,
    lastForwardedAt: null,
    lastProgressAt: isoTime(currentInspector.lastProgressAtMs),
    outputStarted: false,
    termination: "streaming",
    progressTimeoutMs,
  };
  let clientStarted = false;
  let deferOutput = Boolean(deferUntilSemantic && !currentInspector.semanticStarted && !currentInspector.completed);
  let deferredBytes = 0;
  const deferredChunks = firstChunk?.length ? [Buffer.from(firstChunk)] : [];
  deferredBytes += Buffer.byteLength(firstChunk || []);

  const abortOnClose = () => {
    if (!completed) {
      clientClosed = true;
      controller.abort();
    }
  };
  const usageChunks = [Buffer.from(firstChunk || []).toString("utf8")];
  res.on("close", abortOnClose);

  const writeClientChunk = async (chunk) => {
    if (!chunk?.length) return;
    if (!clientStarted) {
      diagnostics.firstForwardedAt = isoTime(Date.now());
      diagnostics.outputStarted = true;
      onStart();
    }
    clientStarted = true;
    diagnostics.lastForwardedAt = isoTime(Date.now());
    diagnostics.forwardedBytes += chunk.length;
    diagnostics.forwardedChunks += 1;
    if (!res.write(chunk)) await onceDrain(res);
  };

  const flushDeferredChunks = async () => {
    if (!deferredChunks.length) return;
    const chunks = deferredChunks.splice(0);
    deferOutput = false;
    for (const chunk of chunks) await writeClientChunk(chunk);
  };

  try {
    if (!deferOutput || deferredBytes >= deferredBufferLimit || Date.now() >= deferredDeadlineMs) await flushDeferredChunks();
    if (currentInspector.completed) {
      await flushDeferredChunks();
      completed = true;
      diagnostics.termination = "completed_event";
      diagnostics.completed = true;
      diagnostics.events = currentInspector.summary();
      controller.abort();
      res.end();
      return { text: usageChunks.join("").slice(-200_000), diagnostics };
    }

    while (!res.destroyed) {
      let chunk;
      if (deferOutput && Date.now() >= deferredDeadlineMs) await flushDeferredChunks();
      if (deferOutput) {
        const pendingRead = readNextChunk(reader, idleTimeoutMs, controller, progressDeadline(currentInspector, progressTimeoutMs));
        let graceTimer;
        let next;
        try {
          next = await Promise.race([
            pendingRead.then((result) => ({ result })),
            new Promise((resolve) => {
              graceTimer = setTimeout(() => resolve({ graceExpired: true }), Math.max(0, deferredDeadlineMs - Date.now()));
            }),
          ]);
        } finally { clearTimeout(graceTimer); }
        if (next.graceExpired) {
          // 长推理不能一直隐藏前导事件；宽限期后转发已缓存内容并结束安全回退窗口。
          await flushDeferredChunks();
          chunk = await pendingRead;
        } else {
          chunk = next.result;
        }
      } else {
        chunk = await readNextChunk(reader, idleTimeoutMs, controller, progressDeadline(currentInspector, progressTimeoutMs));
      }
      if (chunk.done) {
        if (!currentInspector.completed) {
          diagnostics.termination = "upstream_closed_before_completion";
          throw attachStreamDiagnostics(
            retryableError("流式响应在收到终止事件前关闭"),
            diagnostics,
          );
        }
        completed = true;
        diagnostics.termination = "completed";
        diagnostics.events = currentInspector.summary();
        res.end();
        return { text: usageChunks.join("").slice(-200_000), diagnostics };
      }
      const buffer = Buffer.from(chunk.value);
      lastObservedAtMs = Date.now();
      diagnostics.lastChunkAt = isoTime(lastObservedAtMs);
      const chunkText = buffer.toString("utf8");
      const inspection = currentInspector.feed(buffer);
      diagnostics.lastProgressAt = isoTime(currentInspector.lastProgressAtMs);

      // 已经发送给客户端的流不能拼接其他供应商响应，只能中断并交给客户端完整重试。
      if (inspection.error) {
        onChunk(buffer.length, {
          semanticStarted: inspection.semantic,
          completed: inspection.completed,
          progress: inspection.progress,
          state: "streaming",
        });
        usageChunks.push(chunkText);
        if (!deferOutput) await writeClientChunk(buffer);
        const message = `上游流式错误: ${inspection.error.message}`;
        diagnostics.termination = "upstream_structured_error";
        throw inspection.error.retryable
          ? attachStreamDiagnostics(
            retryableError(
              message,
              inspection.error.status,
              inspection.error.affectsCircuit !== false,
              inspection.error.failureClass || classifyProxyFailure(inspection.error),
            ),
            diagnostics,
          )
          : attachStreamDiagnostics(
            nonRetryableError(message, inspection.error.status),
            diagnostics,
          );
      }

      usageChunks.push(chunkText);
      if (usageChunks.join("").length > 200_000) {
        usageChunks.splice(0, Math.max(1, usageChunks.length - 8));
      }
      onChunk(buffer.length, {
        semanticStarted: inspection.semantic,
        completed: inspection.completed,
        progress: inspection.progress,
        state: inspection.semantic ? "streaming" : "probing",
      });
      if (deferOutput) {
        deferredChunks.push(buffer);
        deferredBytes += buffer.length;
        if (inspection.semantic || inspection.completed || deferredBytes >= deferredBufferLimit) {
          await flushDeferredChunks();
        }
      } else {
        await writeClientChunk(buffer);
      }
      if (inspection.completed) {
        await flushDeferredChunks();
        completed = true;
        diagnostics.termination = "completed_event";
        diagnostics.completed = true;
        diagnostics.events = currentInspector.summary();
        controller.abort();
        res.end();
        return { text: usageChunks.join("").slice(-200_000), diagnostics };
      }
    }
    diagnostics.termination = "response_closed_before_completion";
    throw attachStreamDiagnostics(
      retryableError("流式响应在完成前关闭"),
      diagnostics,
    );
  } catch (error) {
    controller.abort();
    const message = `流式响应中断: ${formatFetchError(error)}`;
    const affectsCircuit = error?.affectsCircuit !== false && !clientClosed;
    if (diagnostics.termination === "streaming") {
      diagnostics.termination = clientClosed
        ? "client_connection_closed_before_completion"
        : error?.failureClass === "stream_progress_timeout"
          ? "upstream_progress_timeout"
          : error?.name === "AbortError" || /超时/.test(error?.message || "")
            ? "upstream_idle_timeout"
            : "stream_error";
    }
    diagnostics.completed = completed;
    diagnostics.events = currentInspector.summary();
    diagnostics.lastChunkAt = isoTime(lastObservedAtMs);
    diagnostics.lastProgressAt = isoTime(currentInspector.lastProgressAtMs);
    diagnostics.outputStarted = clientStarted;
    onError(message);
    const canRetryBeforeOutput = !clientStarted && !clientClosed && !res.destroyed;
    if (!canRetryBeforeOutput && !res.destroyed) res.destroy(error);
    const nextError = error?.retryable === false
      ? attachStreamDiagnostics(nonRetryableError(message, error.status), diagnostics)
      : attachStreamDiagnostics(
        retryableError(
          message,
          error.status,
          affectsCircuit,
          clientClosed
            ? "client_connection_closed"
            : error?.failureClass || classifyProxyFailure({
              message,
              status: error?.status,
              affectsCircuit: error?.affectsCircuit,
            }),
        ),
        diagnostics,
      );
    nextError.streamOutputStarted = clientStarted;
    if (clientClosed) nextError.retryable = false;
    nextError.upstreamUsage = extractUsage(null, usageChunks.join(""));
    throw nextError;
  } finally {
    res.off("close", abortOnClose);
  }
}

function progressDeadline(inspector, timeoutMs) {
  return timeoutMs > 0 ? (inspector.lastProgressAtMs ?? inspector.firstChunkAtMs ?? Date.now()) + timeoutMs : 0;
}

function progressTimeoutError() {
  return retryableError("流式响应无有效进展超时（心跳不续期）", 504, true, "stream_progress_timeout");
}

async function readNextChunk(reader, timeoutMs, controller, deadlineMs = 0) {
  const remainingMs = deadlineMs ? deadlineMs - Date.now() : 0;
  if (deadlineMs && remainingMs <= 0) { controller.abort(); throw progressTimeoutError(); }
  const progressExpiresFirst = deadlineMs && (!timeoutMs || remainingMs <= timeoutMs);
  if (!timeoutMs && !progressExpiresFirst) return reader.read();
  return readWithTimeout(reader, progressExpiresFirst ? remainingMs : timeoutMs, controller,
    progressExpiresFirst ? progressTimeoutError : undefined);
}

async function readWithTimeout(reader, timeoutMs, controller, timeoutError = () => retryableError(`流式响应超时: ${timeoutMs}ms 无数据`)) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(timeoutError());
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class SseInspector {
  constructor() {
    this.decoder = new StringDecoder("utf8");
    this.pendingText = "";
    this.eventLines = [];
    this.semanticStarted = false;
    this.completed = false;
    this.validatedEvents = 0;
    this.totalEvents = 0;
    this.unparsedEvents = 0;
    this.eventTypes = new Map();
    this.firstChunkAtMs = null;
    this.lastChunkAtMs = null;
    this.lastProgressAtMs = null;
  }

  feed(value) {
    this.firstChunkAtMs ??= Date.now();
    this.lastChunkAtMs = Date.now();
    this.pendingText += this.decoder.write(Buffer.from(value));
    let error = null;
    let progress = false;
    let newlineIndex;
    while ((newlineIndex = this.pendingText.search(/\r?\n/)) >= 0) {
      const line = this.pendingText.slice(0, newlineIndex);
      this.pendingText = this.pendingText.slice(newlineIndex + (this.pendingText[newlineIndex] === "\r" ? 2 : 1));
      if (line === "") {
        const eventResult = this.finishEvent();
        if (eventResult.error) error ||= eventResult.error;
        if (eventResult.valid) this.validatedEvents += 1;
        if (eventResult.semantic) this.semanticStarted = true;
        if (eventResult.completed) this.completed = true;
        if (eventResult.semantic || eventResult.completed) progress = true;
      } else {
        this.eventLines.push(line);
      }
    }
    if (progress) this.lastProgressAtMs = this.lastChunkAtMs;
    return {
      error,
      semantic: this.semanticStarted,
      completed: this.completed,
      validatedEvents: this.validatedEvents,
      progress,
    };
  }

  finishEvent() {
    if (this.eventLines.length === 0) return {};
    const fields = {};
    const dataLines = [];
    for (const line of this.eventLines) {
      const separator = line.indexOf(":");
      const field = separator >= 0 ? line.slice(0, separator) : line;
      const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
      if (field === "data") dataLines.push(value);
      else if (field === "event") fields.event = value;
    }
    this.eventLines = [];
    this.totalEvents += 1;
    const dataText = dataLines.join("\n").trim();
    if (!dataText) return {};
    if (dataText === "[DONE]") {
      this.rememberEventType("[DONE]");
      return { completed: true };
    }

    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch {
      this.unparsedEvents += 1;
      this.rememberEventType(fields.event || "unparsed");
      return {};
    }
    const eventName = String(fields.event || payload?.type || "").toLowerCase();
    this.rememberEventType(eventName || "structured");
    const error = detectSseErrorEvent(payload, eventName);
    return {
      error,
      valid: !error,
      semantic: hasSseSemanticPayload(payload),
      completed: isSseCompletionEvent(payload, eventName),
    };
  }

  rememberEventType(value) {
    const name = /^[a-z0-9._-]{1,80}$/i.test(String(value || ""))
      ? String(value).toLowerCase()
      : "other";
    if (this.eventTypes.has(name) || this.eventTypes.size < 12) {
      this.eventTypes.set(name, (this.eventTypes.get(name) || 0) + 1);
      return;
    }
    this.eventTypes.set("other", (this.eventTypes.get("other") || 0) + 1);
  }

  summary() {
    return {
      totalEvents: this.totalEvents,
      validatedEvents: this.validatedEvents,
      unparsedEvents: this.unparsedEvents,
      semanticStarted: this.semanticStarted,
      completed: this.completed,
      eventTypes: Object.fromEntries(this.eventTypes),
    };
  }
}

function hasSseSemanticPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const delta = payload.choices[0]?.delta;
    if (delta?.content) return true;
    if (delta?.reasoning || delta?.reasoning_content) return true;
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) return true;
  }
  const responseEventType = String(payload.type || "");
  if (responseEventType.startsWith("response.") && responseEventType.endsWith(".delta") && payload.delta) {
    return true;
  }
  if (payload.type === "response.function_call_arguments.delta" && payload.delta) return true;
  if (payload.type === "response.output_item.added") return true;
  if (payload.type === "response.reasoning_summary_part.added") return true;
  return false;
}

function isSseCompletionEvent(payload, eventName) {
  return eventName === "response.completed" ||
    payload?.type === "response.completed" ||
    payload?.response?.status === "completed";
}

function detectSseErrorEvent(payload, eventName) {
  if (!payload || typeof payload !== "object") return null;
  const direct = payload.error || payload.failure || payload.response?.error || null;
  const explicitFailure = eventName === "error" ||
    eventName === "response.failed" ||
    payload.type === "error" ||
    payload.type === "response.failed" ||
    payload.response?.status === "failed";
  if (!explicitFailure && !direct) return null;

  const source = direct || payload;
  const message = String(source.message || source.error || payload.message || "上游流式错误");
  const lower = message.toLowerCase();
  const code = String(source.code || source.type || payload.code || payload.type || "").toLowerCase();
  const authenticationError = code.includes("auth") ||
    code.includes("api_key") ||
    lower.includes("api key") ||
    lower.includes("unauthorized");
  const rateLimitError = code.includes("rate_limit") || code.includes("too_many_requests");
  const capacityError = code.includes("capacity") || code.includes("overload") || isCapacityText(message);
  const invalidRequestError = code.includes("invalid_request") || code.includes("bad_request") ||
    code.includes("validation_error") || code.includes("unsupported_value");
  const unsupportedModelError = isUnsupportedModelText(`${code} ${message}`);
  // 某些 SSE 供应商只给 response_not_found/previous_response_id，不携带数字状态码。
  // 先用 404 试探同一白名单规则，避免把上下文失配误归为普通 502。
  const responseContextHint = detectKnownResponseContextFields({
    status: 404,
    code,
    param: source.param || payload.param,
    message,
  });
  const numericStatus = Number(
    source.status || source.statusCode || payload.status || payload.statusCode || source.code,
  );
  const status = Number.isFinite(numericStatus) && numericStatus >= 100
    ? numericStatus
    : authenticationError
      ? 401
      : rateLimitError
        ? 429
        : unsupportedModelError
          ? 404
          : responseContextHint
            ? 404
            : invalidRequestError
              ? 400
              : capacityError
                ? 503
                : 502;
  const retryable = status >= 500 || status === 401 || status === 403 || status === 429 ||
    rateLimitError || capacityError || unsupportedModelError;
  const compatibilityError = detectKnownProviderCompatibilityFields({
    status,
    code,
    param: source.param || payload.param,
    message,
  });
  const responseContextError = responseContextHint || detectKnownResponseContextFields({
    status,
    code,
    param: source.param || payload.param,
    message,
  });
  return {
    status,
    retryable: retryable || Boolean(compatibilityError) || Boolean(responseContextError),
    message,
    affectsCircuit: compatibilityError || responseContextError ? false : !unsupportedModelError,
    failureClass: compatibilityError?.failureClass || responseContextError?.failureClass || "",
    compatibilityRuleId: compatibilityError?.ruleId || responseContextError?.ruleId || "",
  };
}

function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => onError(nonRetryableError("客户端在等待写缓冲恢复期间断开", 499));
    // 成功、失败与断开都成组清理，避免长响应累积监听器或永久停在背压等待。
    if (stream.destroyed) { onClose(); return; }
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}
