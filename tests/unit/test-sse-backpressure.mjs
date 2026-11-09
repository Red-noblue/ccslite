/**
 * 流式写入背压回归测试：反复等待写缓冲恢复后不得遗留监听器，断开与写入失败必须结束等待。
 * 使用本机真实 Writable，不访问供应商或正式服务。
 */
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { pipeSseReadableStream } from "../../lib/sse-stream.js";

const delta = Buffer.from('data: {"type":"response.output_text.delta","delta":"本机测试"}\n\n');
const completed = Buffer.from('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');

function pipe(response, controller = new AbortController(), count = 1) {
  const chunks = [...Array(count).fill(delta), completed];
  return pipeSseReadableStream(response, {
    async read() { return chunks.length ? { done: false, value: chunks.shift() } : { done: true }; },
  }, controller, delta);
}

test("重复触发写入背压不会积累事件监听器", async () => {
  const response = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) { setImmediate(callback); },
  });
  const foreignError = () => {};
  response.on("error", foreignError);
  const result = await pipe(response, new AbortController(), 32);
  assert.equal(result.diagnostics.completed, true);
  assert.equal(result.diagnostics.forwardedChunks, 34);
  assert.deepEqual(response.listeners("error"), [foreignError]);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("背压写入失败会清理未触发的监听器", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const response = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) { setImmediate(() => callback(new Error("本机写入失败"))); },
  });
  await assert.rejects(pipe(response, controller), /本机写入失败/);
  assert.equal(controller.signal.aborted, true);
  for (const name of ["drain", "error", "close"]) assert.equal(response.listenerCount(name), 0, name);
});

test("背压等待期间客户端断开会结束等待", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const response = new Writable({
    highWaterMark: 1,
    write() { setImmediate(() => response.destroy()); },
  });
  await assert.rejects(pipe(response, controller), error => error.status === 499);
  assert.equal(controller.signal.aborted, true);
  for (const name of ["drain", "error", "close"]) assert.equal(response.listenerCount(name), 0, name);
});

test("写入同步关闭时不会遗留背压等待", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const response = new Writable({
    highWaterMark: 1,
    write() { this.destroy(); },
  });
  await assert.rejects(pipe(response, controller), error => error.status === 499);
  assert.equal(controller.signal.aborted, true);
  for (const name of ["drain", "error", "close"]) assert.equal(response.listenerCount(name), 0, name);
});
