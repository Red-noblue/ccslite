/** 合成兼容检查测试：流式完整性、工具往返、响应上下文和资源上限全部由模拟上游验证。 */
import assert from "node:assert/strict";
import test from "node:test";
import { runProviderCompatibility } from "../../lib/provider-compatibility.js";

const provider = { id: "fake", baseUrl: "http://127.0.0.1:1", apiKey: "fake-secret", authMode: "api_key" };
const message = (text) => ({ type: "message", content: [{ type: "output_text", text }] });
function simulator({ truncateStream = false, contextMissing = false } = {}) {
  const requests = [];
  let marker;
  return { requests, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body.toString()); requests.push(body);
    assert.equal(options.headers.get("authorization"), "Bearer fake-secret");
    let output = [message("CCOK")];
    if (body.tool_choice?.name) output = [{ type: "function_call", name: "ccslite_compat_ping", call_id: "call-1", arguments: "{}" }];
    if (body.tool_choice === "none") {
      const call = body.input.find((item) => item.type === "function_call");
      const result = body.input.find((item) => item.type === "function_call_output");
      assert.equal(result.call_id, call.call_id); output = [message(result.output)];
    }
    if (body.store && !body.previous_response_id) { marker = body.input[0].content[0].text.match(/CTX_[a-f0-9]+/)[0]; output = [message("OK")]; }
    if (body.previous_response_id) {
      assert.doesNotMatch(JSON.stringify(body.input), /CTX_/);
      if (contextMissing) return new Response('{"error":"private auth fake-secret"}', { status: 404 });
      output = [message(marker)];
    }
    const response = { id: "resp-1", model: body.model, status: "completed", output, usage: { input_tokens: 3, output_tokens: 2 } };
    const isBaseline = !body.store && !body.tool_choice;
    const event = truncateStream && isBaseline ? { type: "response.output_text.delta", delta: "CCOK" } : { type: "response.completed", response };
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    // 任意字节分片不能破坏 SSE 结束事件解析。
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  } };
}

test("五次请求验证三项能力，工具结果和上下文必须真实往返，且不修改配置", async () => {
  const mock = simulator(); const samples = []; const before = structuredClone(provider);
  const result = await runProviderCompatibility({ provider, model: "mock-model", fetchImpl: mock.fetchImpl, onUsage: async (sample) => samples.push(sample) });
  assert.equal(result.requestCount, 5);
  assert.deepEqual(result.results.map((item) => item.outcome), ["passed", "passed", "passed"]);
  assert.equal(samples.length, 5); assert.deepEqual(provider, before); assert.equal(result.routingEffect, "none");
  assert.doesNotMatch(JSON.stringify(result), /fake-secret|CTX_|TOOL_|resp-1/);
});

test("HTTP 200 截断流和上下文 404 不会误报通过，也不会阻止独立工具检查", async () => {
  const mock = simulator({ truncateStream: true, contextMissing: true });
  const result = await runProviderCompatibility({ provider, model: "mock-model", fetchImpl: mock.fetchImpl });
  assert.deepEqual(result.results.map((item) => item.outcome), ["failed", "passed", "failed"]);
  assert.match(result.results[0].message, /response.completed/);
  assert.match(result.results[2].message, /404/);
  assert.doesNotMatch(JSON.stringify(result), /fake-secret/);
});

test("超大响应立即取消读取，取消检查后不再发起后续请求", async () => {
  let cancelled = 0;
  const controller = new AbortController();
  const result = await runProviderCompatibility({ provider, model: "mock-model", signal: controller.signal,
    fetchImpl: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(512 * 1024 + 1)); }, cancel() { cancelled += 1; } })),
    onUsage: async () => controller.abort(),
  });
  assert.equal(cancelled, 1); assert.equal(result.requestCount, 1);
  assert.deepEqual(result.results.map((item) => item.outcome), ["failed", "skipped", "skipped"]);
  assert.match(result.results[0].message, /512 KiB/);
});


test("配置中的模型映射被沿用，接口降级返回别的模型仍会失败", async () => {
  const mock = simulator();
  const result = await runProviderCompatibility({ provider: { ...provider, modelMap: { alias: "mapped-model" } }, model: "alias", fetchImpl: mock.fetchImpl });
  assert.deepEqual(result.results.map((item) => item.outcome), ["passed", "passed", "passed"]);
  assert.ok(mock.requests.every((body) => body.model === "mapped-model"));
  const mismatch = await runProviderCompatibility({ provider, model: "requested", fetchImpl: async () => new Response(JSON.stringify({ model: "wrong-model", status: "completed", output: [] })) });
  assert.ok(mismatch.results.every((item) => item.outcome === "failed"));
});

test("上游永久等待会超时退出，每项失败仍不隐式重试或切换供应商", async () => {
  let calls = 0;
  const result = await runProviderCompatibility({ provider, model: "mock", timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => { calls += 1; return new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }); },
  });
  assert.equal(calls, 3); assert.equal(result.requestCount, 3);
  assert.ok(result.results.every((item) => item.outcome === "failed"));
});
