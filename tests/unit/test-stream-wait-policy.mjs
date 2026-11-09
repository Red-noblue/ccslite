/**
 * 流式等待边界测试：固定首包回退窗口，心跳不能延长有效进展期限。
 * 使用可控时钟验证边界，不连接真实供应商、不产生计费请求。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSseInspector, pipeSseReadableStream, probeSseStream } from "../../lib/sse-stream.js";
import { DEFAULT_STREAM_POLICY, normalizeStreamPolicy } from "../../lib/stream-policy.js";

const CREATED = Buffer.from('data: {"type":"response.created"}\n\n');
const HEARTBEAT = Buffer.from(": heartbeat\n\n");
const DELTA = Buffer.from('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
const COMPLETED = Buffer.from('data: {"type":"response.completed"}\n\n');

class Response extends EventEmitter {
  chunks = [];
  destroyed = false;
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
  end() { this.emit("close"); }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("旧配置沿用 1.5 秒和 256 KiB，治理默认关闭；显式零值和未修改字段保留", () => {
  assert.deepEqual(normalizeStreamPolicy({}), DEFAULT_STREAM_POLICY);
  const current = { streamingDeferredOutputGraceMs: 0, streamingDeferredBufferBytes: 4096, streamingProgressTimeoutMs: 0 };
  assert.deepEqual(normalizeStreamPolicy({}, current), current);
  assert.deepEqual(normalizeStreamPolicy({ streamingProgressTimeoutMs: 500 }, current), { ...current, streamingProgressTimeoutMs: 500 });
});

test("非法参数回到原值，数值按可执行的整数边界保存", () => {
  assert.deepEqual(normalizeStreamPolicy({
    streamingDeferredOutputGraceMs: "bad", streamingDeferredBufferBytes: -1, streamingProgressTimeoutMs: 999999999999,
  }), { ...DEFAULT_STREAM_POLICY, streamingDeferredBufferBytes: 1024, streamingProgressTimeoutMs: 86400000 });
  assert.equal(normalizeStreamPolicy({ streamingDeferredOutputGraceMs: 12.5 }).streamingDeferredOutputGraceMs, 12);
});

test("有效进展按本次事件判断，推理和工具输出可续期，之后的心跳不算新进展", () => {
  const inspector = createSseInspector();
  assert.equal(inspector.feed(Buffer.from('data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n')).progress, true);
  assert.equal(inspector.feed(HEARTBEAT).progress, false);
  assert.equal(inspector.feed(Buffer.from('data: {"type":"response.function_call_arguments.delta","delta":"{}"}\n\n')).progress, true);
  assert.equal(inspector.feed(CREATED).progress, false);
  assert.equal(inspector.semanticStarted, true);
});

test("首个合法生命周期事件直接交给有界缓冲，不等待第二个事件", async () => {
  const result = await probeSseStream({ read() { throw new Error("不应继续等待第二个事件"); } },
    CREATED, 1000, { abort() {} });
  assert.equal(result.sseInspector.validatedEvents, 1);
  assert.equal(result.sseInspector.semanticStarted, false);
});

test("连续心跳不重置首包起算的安全回退窗口", async (t) => {
  let clock = 1000;
  t.mock.method(Date, "now", () => clock);
  const inspector = createSseInspector();
  inspector.feed(CREATED);
  const response = new Response();
  let reads = 0;
  await pipeSseReadableStream(response, {
    async read() {
      reads += 1;
      if (reads === 4) assert.ok(response.chunks.length > 0, "总窗口已到期，应已发送前导");
      clock += 100;
      return { done: false, value: reads < 5 ? HEARTBEAT : COMPLETED };
    },
  }, { abort() {} }, CREATED, inspector, {}, {
    deferUntilSemantic: true, deferredOutputGraceMs: 250,
  });
  assert.ok(response.chunks[0].equals(CREATED));
});

for (const mode of ["zero", "buffer"]) {
  test(`${mode === "zero" ? "零等待" : "首包已达缓冲上限"}会立即转发，不等待后续数据`, async () => {
    const inspector = createSseInspector();
    inspector.feed(CREATED);
    const response = new Response();
    await pipeSseReadableStream(response, {
      async read() {
        assert.ok(response.chunks.length > 0);
        return { done: false, value: COMPLETED };
      },
    }, { abort() {} }, CREATED, inspector, {}, {
      deferUntilSemantic: true,
      deferredOutputGraceMs: mode === "zero" ? 0 : 1500,
      deferredBufferLimit: mode === "buffer" ? CREATED.length : 262144,
    });
  });
}

test("持续心跳仍会触发无进展超时，未输出时可安全重试", async () => {
  const inspector = createSseInspector();
  inspector.feed(CREATED);
  const response = new Response();
  let reads = 0;
  let aborted = false;
  await assert.rejects(pipeSseReadableStream(response, {
    async read() {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { done: false, value: ++reads < 10 ? HEARTBEAT : COMPLETED };
    },
  }, { abort() { aborted = true; } }, CREATED, inspector, {}, {
    idleTimeoutMs: 1000, progressTimeoutMs: 60,
    deferUntilSemantic: true, deferredOutputGraceMs: 500,
  }), (error) => error.failureClass === "stream_progress_timeout" &&
    error.streamOutputStarted === false && error.streamDiagnostics.termination === "upstream_progress_timeout");
  assert.equal(aborted, true);
  assert.equal(response.chunks.length, 0);
  assert.equal(response.destroyed, false);
  assert.equal(response.listenerCount("close"), 0);
});

test("只有心跳的未验证前导也受无进展期限约束", async () => {
  let reads = 0;
  await assert.rejects(probeSseStream({
    async read() {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { done: false, value: ++reads < 10 ? HEARTBEAT : COMPLETED };
    },
  }, HEARTBEAT, 1000, { abort() {} }, () => {}, { progressTimeoutMs: 60 }),
  (error) => error.failureClass === "stream_progress_timeout" &&
    error.streamDiagnostics.termination === "upstream_progress_timeout");
});

test("前导探测已耗掉的时间不会在转发阶段重新获得等待窗口", async (t) => {
  let clock = 1000;
  t.mock.method(Date, "now", () => clock);
  const inspector = createSseInspector();
  inspector.feed(CREATED);
  clock += 2000;
  const response = new Response();
  await pipeSseReadableStream(response, { async read() {
    assert.ok(response.chunks.length > 0);
    return { done: false, value: COMPLETED };
  } }, { abort() {} }, CREATED, inspector, {}, { deferUntilSemantic: true });
});

test("文本进展会续期，长时间正常输出可以完成", async (t) => {
  let clock = 1000;
  t.mock.method(Date, "now", () => clock);
  const inspector = createSseInspector();
  inspector.feed(DELTA);
  let reads = 0;
  const result = await pipeSseReadableStream(new Response(), {
    async read() {
      clock += 100;
      return { done: false, value: ++reads < 6 ? DELTA : COMPLETED };
    },
  }, { abort() {} }, DELTA, inspector, {}, { progressTimeoutMs: 150 });
  assert.equal(result.diagnostics.completed, true);
  assert.ok(clock - 1000 > 150);
});

test("无进展超时默认关闭，只有心跳也可以等待完成", async (t) => {
  let clock = 1000;
  t.mock.method(Date, "now", () => clock);
  const inspector = createSseInspector();
  inspector.feed(CREATED);
  let reads = 0;
  const result = await pipeSseReadableStream(new Response(), {
    async read() {
      clock += 3_600_000;
      return { done: false, value: ++reads < 4 ? HEARTBEAT : COMPLETED };
    },
  }, { abort() {} }, CREATED, inspector, {}, {});
  assert.equal(result.diagnostics.completed, true);
});
