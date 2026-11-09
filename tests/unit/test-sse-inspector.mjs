/**
 * SSE 事件检测器测试。
 *
 * 验证鉴权错误故障转移所需的结构化判断，同时确保模型正常输出中的错误文字不会误判。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.LITE_CCSWITCH_SKIP_BOOTSTRAP = "1";
const { createSseInspector, pipeReadableStream, probeSseStream } = await import("../../server.js");
const { pipeSseReadableStream } = await import("../../lib/sse-stream.js");

function createReader(chunks) {
  const queue = [...chunks];
  return {
    async read() {
      return queue.length > 0
        ? { done: false, value: Buffer.from(queue.shift()) }
        : { done: true, value: undefined };
    },
  };
}

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.ended = false;
    this.chunks = [];
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end() {
    this.ended = true;
    this.emit("close");
  }
}

test("跨数据块的结构化 API Key 错误会被识别", () => {
  const inspector = createSseInspector();
  const first = inspector.feed(Buffer.from(
    'event: error\ndata: {"type":"error","error":{"message":"Failed to val',
  ));
  assert.equal(first.error, null);

  const second = inspector.feed(Buffer.from('idate API key"}}\n\n'));
  assert.equal(second.error?.status, 401);
  assert.equal(second.error?.retryable, true);
  assert.equal(inspector.semanticStarted, false);
});

test("模型正文包含相同文字时不会误判", () => {
  const inspector = createSseInspector();
  const result = inspector.feed(Buffer.from(
    'event: response.output_text.delta\n' +
    'data: {"type":"response.output_text.delta","delta":"Failed to validate API key"}\n\n',
  ));
  assert.equal(result.error, null);
  assert.equal(result.semantic, true);
});

test("SSE 诊断只保留事件结构，不记录正文", () => {
  const inspector = createSseInspector();
  inspector.feed(Buffer.from(
    'event: response.output_text.delta\n' +
    'data: {"type":"response.output_text.delta","delta":"仅用于验证日志不会保存的敏感正文"}\n\n',
  ));
  const summary = inspector.summary();

  assert.deepEqual(summary.eventTypes, { "response.output_text.delta": 1 });
  assert.equal(summary.totalEvents, 1);
  assert.equal(summary.validatedEvents, 1);
  assert.equal(summary.unparsedEvents, 0);
  assert.equal(JSON.stringify(summary).includes("敏感正文"), false);
});

test("模型输出的 JSON 错误示例不会误判", () => {
  const inspector = createSseInspector();
  const result = inspector.feed(Buffer.from(
    'data: {"choices":[{"delta":{"content":"{\\"error\\":\\"Failed to validate API key\\"}"}}]}\n\n',
  ));
  assert.equal(result.error, null);
  assert.equal(result.semantic, true);
});

test("普通 SSE 消息中的鉴权文字不会误判", () => {
  const inspector = createSseInspector();
  const result = inspector.feed(Buffer.from(
    'event: message\ndata: {"message":"Failed to validate API key"}\n\n',
  ));
  assert.equal(result.error, null);
});

test("response.failed 中的鉴权错误会被识别", () => {
  const inspector = createSseInspector();
  const result = inspector.feed(Buffer.from(
    'event: response.failed\n' +
    'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_api_key","message":"认证失败"}}}\n\n',
  ));
  assert.equal(result.error?.status, 401);
  assert.equal(result.error?.retryable, true);
});

test("结构化业务错误不会标记为可重试", () => {
  const inspector = createSseInspector();
  const result = inspector.feed(Buffer.from(
    'event: response.failed\n' +
    'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_request","message":"参数错误"}}}\n\n',
  ));
  assert.equal(result.error?.status, 400);
  assert.equal(result.error?.retryable, false);
});

test("明确的 parallel_tool_calls 兼容错误允许在 SSE 前导阶段故障转移", () => {
  const inspector = createSseInspector();
  const result = inspector.feed(Buffer.from(
    'event: error\n' +
    'data: {"type":"error","error":{"code":"unsupported_value","param":"parallel_tool_calls","message":"X-OpenAI-Internal-Codex-Responses-Lite requires `parallel_tool_calls` to be false."}}\n\n',
  ));
  assert.equal(result.error?.status, 400);
  assert.equal(result.error?.retryable, true);
  assert.equal(result.error?.affectsCircuit, false);
  assert.equal(result.error?.failureClass, "provider_compatibility");
});

test("没有数字状态码的 response_not_found 也能识别上下文失配", () => {
  const inspector = createSseInspector();
  const result = inspector.feed(Buffer.from(
    'event: error\n' +
    'data: {"type":"error","error":{"code":"response_not_found","param":"previous_response_id","message":"response_id resp_old not found"}}\n\n',
  ));
  assert.equal(result.error?.status, 404);
  assert.equal(result.error?.retryable, true);
  assert.equal(result.error?.affectsCircuit, false);
  assert.equal(result.error?.failureClass, "response_context_incompatible");
});

test("结构化限流错误会标记为可重试", () => {
  const inspector = createSseInspector();
  const result = inspector.feed(Buffer.from(
    'event: error\ndata: {"type":"error","error":{"status":429,"message":"请求过多"}}\n\n',
  ));
  assert.equal(result.error?.status, 429);
  assert.equal(result.error?.retryable, true);
});

test("正常终止事件和 DONE 标记会被识别", () => {
  const responsesInspector = createSseInspector();
  const completed = responsesInspector.feed(Buffer.from(
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  ));
  assert.equal(completed.completed, true);

  const chatInspector = createSseInspector();
  assert.equal(chatInspector.feed(Buffer.from("data: [DONE]\n\n")).completed, true);
});

test("收到完成事件后不等待上游 EOF，直接正常结束客户端流", async () => {
  const firstChunk = Buffer.from(
    'event: response.created\ndata: {"type":"response.created"}\n\n',
  );
  const completedChunk = Buffer.from(
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  );
  const inspector = createSseInspector();
  inspector.feed(firstChunk);
  const response = new TestResponse();
  let abortCount = 0;
  const result = await pipeReadableStream(
    response,
    createReader([completedChunk]),
    { abort: () => { abortCount += 1; } },
    firstChunk,
    inspector,
    { preambleBytes: firstChunk.length, probeOutcome: "validated_events" },
  );

  assert.equal(response.ended, true);
  assert.equal(abortCount, 1);
  assert.equal(result.diagnostics.termination, "completed_event");
  assert.equal(result.diagnostics.completed, true);
  assert.equal(result.diagnostics.events.completed, true);
  assert.match(result.text, /response\.completed/);
});

test("有效输出前的生命周期流断开时不会写入客户端，可以安全回退", async () => {
  const firstChunk = Buffer.from(
    'event: response.created\ndata: {"type":"response.created"}\n\n',
  );
  const inspector = createSseInspector();
  inspector.feed(firstChunk);
  const response = new TestResponse();

  await assert.rejects(
    pipeReadableStream(
      response,
      createReader([
        'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n',
      ]),
      { abort() {} },
      firstChunk,
      inspector,
      { preambleBytes: firstChunk.length, probeOutcome: "validated_lifecycle_over_limit" },
      1000,
      null,
      true,
    ),
    (error) => error.retryable === true && error.streamOutputStarted === false,
  );
  assert.deepEqual(response.chunks, []);
  assert.equal(response.destroyed, false);
});

test("安全回退宽限期结束后会先发送缓存的生命周期事件", async () => {
  const firstChunk = Buffer.from(
    'event: response.created\ndata: {"type":"response.created"}\n\n',
  );
  const outputChunk = Buffer.from(
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
  );
  const completedChunk = Buffer.from(
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  );
  const inspector = createSseInspector();
  inspector.feed(firstChunk);
  let reads = 0;
  const reader = {
    async read() {
      reads += 1;
      if (reads === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { done: false, value: outputChunk };
      }
      return { done: false, value: completedChunk };
    },
  };
  const response = new TestResponse();
  await pipeSseReadableStream(
    response,
    reader,
    { abort() {} },
    firstChunk,
    inspector,
    { preambleBytes: firstChunk.length, probeOutcome: "validated_lifecycle_over_limit" },
    { deferUntilSemantic: true, deferredOutputGraceMs: 5 },
  );

  assert.match(response.chunks[0].toString("utf8"), /response\.created/);
  assert.match(response.chunks.at(-1).toString("utf8"), /response\.completed/);
});

test("首个有效输出前的鉴权错误会中止上游并抛出可重试错误", async () => {
  let aborted = false;
  const controller = { abort: () => { aborted = true; } };
  const reader = createReader([
    'event: error\ndata: {"type":"error","message":"Failed to validate API key"}\n\n',
  ]);
  await assert.rejects(
    (async () => {
      const result = await probeSseStream(reader,
        Buffer.from('event: response.created\ndata: {"type":"response.created"}\n\n'), 1000, controller);
      return pipeSseReadableStream(new TestResponse(), reader, controller,
        result.preamble, result.sseInspector, result.sseDiagnostics, { deferUntilSemantic: true });
    })(),
    (error) => error.status === 401 && error.retryable === true,
  );
  assert.equal(aborted, true);
});

test("连续的合法 SSE 前导事件不会因超过 64KB 被误判", async () => {
  let aborted = false;
  const controller = { abort: () => { aborted = true; } };
  const reasoningEvent =
    'event: response.reasoning_summary_text.delta\n' +
    `data: {"type":"response.reasoning_summary_text.delta","delta":"${"x".repeat(40_000)}"}\n\n`;
  const reader = createReader([reasoningEvent, reasoningEvent]);
  const result = await probeSseStream(
    reader,
    Buffer.from(': heartbeat\n\n'),
    1000,
    controller,
  );

  assert.equal(aborted, false);
  assert.ok(result.preamble.length < 64 * 1024);
  assert.equal(result.sseInspector.semanticStarted, true);
});

test("SSE 前导探测会报告首包和后续数据块", async () => {
  const chunks = [];
  const controller = { abort: () => {} };
  const first = Buffer.from(': heartbeat\n\n');
  const next = Buffer.from('event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n');
  await probeSseStream({
    async read() { return { done: false, value: next }; },
  }, first, 1000, controller, (bytes, patch) => chunks.push({ bytes, state: patch.state }));
  assert.deepEqual(chunks, [
    { bytes: first.length, state: "probing" },
    { bytes: next.length, state: "probing" },
  ]);
});

test("单条超长推理增量会被视为正常响应而非前导异常", async () => {
  let aborted = false;
  const controller = { abort: () => { aborted = true; } };
  const reasoningEvent =
    'event: response.reasoning_summary_text.delta\n' +
    `data: {"type":"response.reasoning_summary_text.delta","delta":"${"x".repeat(70_000)}"}\n\n`;
  const result = await probeSseStream(
    createReader([reasoningEvent]),
    Buffer.from(': heartbeat\n\n'),
    1000,
    controller,
  );

  assert.equal(aborted, false);
  assert.ok(result.preamble.length > 64 * 1024);
  assert.equal(result.sseInspector.semanticStarted, true);
});

test("生命周期事件后的超长 SSE 前导会继续转发", async () => {
  let aborted = false;
  const controller = { abort: () => { aborted = true; } };
  const reader = createReader([`data: ${"x".repeat(70_000)}\n\n`, 'data: {"type":"response.completed"}\n\n']);
  const result = await probeSseStream(
    reader,
    Buffer.from('event: response.created\ndata: {"type":"response.created"}\n\n'),
    1000,
    controller,
  );

  assert.equal(aborted, false);
  assert.equal(result.sseInspector.validatedEvents, 1);
  const response = new TestResponse();
  await pipeSseReadableStream(response, reader, controller,
    result.preamble, result.sseInspector, result.sseDiagnostics, { deferUntilSemantic: true });
  assert.ok(Buffer.concat(response.chunks).length > 64 * 1024);
  assert.equal(response.ended, true);
});

test("无法解析的超长 SSE 前导不会计入供应商断路器", async () => {
  let aborted = false;
  const controller = { abort: () => { aborted = true; } };
  const reader = createReader(["x".repeat(70_000)]);
  await assert.rejects(
    probeSseStream(reader, Buffer.from("data: not-json\n\n"), 1000, controller),
    (error) => error.retryable === true && error.affectsCircuit === false,
  );
  assert.equal(aborted, true);
});

test("没有终止事件就关闭的前导流会作为可重试错误处理", async () => {
  let aborted = false;
  const controller = { abort: () => { aborted = true; } };
  const reader = createReader([]);
  await assert.rejects(
    (async () => {
      const result = await probeSseStream(reader,
        Buffer.from('event: response.created\ndata: {"type":"response.created"}\n\n'), 1000, controller);
      return pipeSseReadableStream(new TestResponse(), reader, controller,
        result.preamble, result.sseInspector, result.sseDiagnostics, { deferUntilSemantic: true });
    })(),
    (error) => error.retryable === true && error.message.includes("终止事件前关闭"),
  );
  assert.equal(aborted, true);
});
