/**
 * 中文升级交接队列测试：验证排队、放行、取消、上限和关闭，不启动真实服务。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHandoffQueue } from "../../lib/handoff-queue.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("开放状态直接转发，排空状态暂存后统一放行", async () => {
  const calls = []; const queue = createHandoffQueue();
  assert.equal(await queue.route({ id: 1 }, async (request) => { calls.push(request.id); return "direct"; }), "direct");
  queue.beginDrain();
  const pending = queue.route({ id: 2 });
  assert.equal(queue.stats().queuedRequests, 1);
  queue.activate(async (request) => { calls.push(request.id); return `released-${request.id}`; });
  assert.equal(await pending, "released-2"); assert.deepEqual(calls, [1, 2]);
});

test("客户端取消会移除排队请求且不调用候选版本", async () => {
  const controller = new AbortController(); let called = false; const queue = createHandoffQueue();
  queue.beginDrain(); const pending = queue.route({ body: Buffer.from("x"), signal: controller.signal }); controller.abort();
  await assert.rejects(pending, (error) => error.code === "client_cancelled" && error.status === 499);
  queue.activate(async () => { called = true; }); await pause(5);
  assert.equal(called, false); assert.deepEqual(queue.stats(), { state: "open", queuedRequests: 0, queuedBytes: 0, inFlight: 0 });
});

test("数量和请求体字节数上限返回可重试或明确过大的错误", async () => {
  const queue = createHandoffQueue({ maxRequests: 1, maxBytes: 3 }); queue.beginDrain();
  const first = queue.route({ body: Buffer.from("abc") });
  await assert.rejects(queue.route({ body: Buffer.from("d") }), (error) => error.code === "handoff_queue_full" && error.retryAfter === 1);
  queue.close(); await assert.rejects(first, (error) => error.code === "handoff_closed");
  const bytes = createHandoffQueue({ maxBytes: 2 }); bytes.beginDrain();
  await assert.rejects(bytes.route({ body: Buffer.from("abc") }), (error) => error.code === "handoff_body_too_large" && error.status === 413);
});

test("达到等待上限时释放请求并返回可观察的 503", async () => {
  const queue = createHandoffQueue({ maxWaitMs: 15 }); queue.beginDrain();
  const pending = queue.route({ body: Buffer.from("ok") });
  await assert.rejects(pending, (error) => error.code === "handoff_queue_timeout" && error.status === 503 && error.retryAfter === 1);
  assert.equal(queue.stats().queuedRequests, 0);
});

test("默认不因固定等待时间结束，交接完成后才释放排队请求", async () => {
  const queue = createHandoffQueue(); queue.beginDrain();
  const pending = queue.route({ body: Buffer.from("wait") });
  await pause(40); assert.equal(queue.stats().queuedRequests, 1);
  queue.activate(async () => "released"); assert.equal(await pending, "released");
});

test("候选目标失败只影响排队请求，队列仍可关闭并清理", async () => {
  const queue = createHandoffQueue(); queue.beginDrain();
  const pending = queue.route({ id: 1 }); queue.activate(async () => { throw Object.assign(new Error("候选故障"), { status: 502 }); });
  await assert.rejects(pending, /候选故障/); assert.equal(queue.stats().inFlight, 0);
  const failure = Object.assign(new Error("恢复次数已耗尽"), { code: "handoff_recovery_exhausted", status: 503 });
  queue.close(failure); assert.equal(queue.state(), "closed");
  await assert.rejects(queue.route({ id: 2 }), (error) => error === failure);
});

test("入队前已取消的请求立即结束，重复激活也不能重复发送同一请求", async () => {
  const queue = createHandoffQueue(); queue.beginDrain();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(queue.route({ signal: controller.signal }), (error) => error.code === "client_cancelled");
  let calls = 0; let release;
  const target = async () => { calls += 1; return new Promise((resolve) => { release = resolve; }); };
  const pending = queue.route({ body: "一次请求" });
  queue.activate(target); queue.activate(target);
  assert.equal(calls, 1); release("完成"); assert.equal(await pending, "完成");
  assert.equal(queue.stats().queuedBytes, 0); queue.close();
});

test("直接转发在目标执行之前即计入排空，并在成功和失败后释放", async () => {
  const queue = createHandoffQueue(); let finish;
  const pending = queue.route({}, () => new Promise((resolve) => { finish = resolve; }));
  assert.equal(queue.stats().inFlight, 1);
  queue.beginDrain(); await pause(1);
  assert.equal(queue.stats().inFlight, 1);
  finish("完成"); assert.equal(await pending, "完成"); assert.equal(queue.stats().inFlight, 0);
  queue.activate(() => { throw new Error("转发失败"); });
  await assert.rejects(queue.route({}), /转发失败/); assert.equal(queue.stats().inFlight, 0);
});
