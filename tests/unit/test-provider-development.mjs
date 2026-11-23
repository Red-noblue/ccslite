/** 开发能力验收：使用真实隔离文件与固定 Node 子进程，模拟上游验证预算、工具历史、误判和取消。 */
import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProviderDevelopment } from "../../lib/provider-development.js";
import { createDevelopmentTask } from "../../lib/development-task.js";
import { createDevelopmentProvider } from "../helpers/development-provider.mjs";
const provider = { id: "mock", baseUrl: "http://127.0.0.1:1", authMode: "api_key", apiKey: "never-report-this-secret" };

test("真实读写、命令与独立校验全部通过，完整工具历史按 call_id 回传", async () => {
  const mock = createDevelopmentProvider(); const usage = []; const before = structuredClone(provider);
  const result = await runProviderDevelopment({ provider, model: "alias", fetchImpl: mock.fetchImpl, onUsage: async (sample) => usage.push(sample) });
  assert.equal(result.outcome, "passed"); assert.equal(result.requestCount, 4); assert.equal(usage.length, 4);
  assert.ok(result.results.every((item) => item.outcome === "passed")); assert.equal(result.steps.length, 6);
  assert.equal(result.routingEffect, "none"); assert.deepEqual(provider, before);
  assert.doesNotMatch(JSON.stringify(result), /never-report|nonce|commandCode|ccslite-development-/);
  for (let index = 1; index < mock.requests.length; index++) {
    const prior = mock.requests[index - 1].input;
    assert.deepEqual(mock.requests[index].input.slice(0, prior.length), prior);
    for (const item of mock.requests[index].input.filter((item) => item.type === "function_call_output")) assert.ok(mock.requests[index].input.some((call) => call.type === "function_call" && call.call_id === item.call_id));
  }
});

test("拒绝越界后允许模型修正，临时工具错误不会使最终成功变失败", async () => {
  const mock = createDevelopmentProvider({ repair: true });
  const result = await runProviderDevelopment({ provider, model: "mock", fetchImpl: mock.fetchImpl });
  assert.equal(result.outcome, "passed"); assert.equal(result.requestCount, 5); assert.equal(result.steps[0].ok, false);
});

test("文件首次写错后能够根据校验失败修正并重新验证", async () => {
  const mock = createDevelopmentProvider({ repairResult: true });
  const result = await runProviderDevelopment({ provider, model: "mock", fetchImpl: mock.fetchImpl });
  assert.equal(result.outcome, "passed"); assert.equal(result.requestCount, 6);
  assert.ok(result.steps.some(item => item.tool === "run_command" && !item.ok));
});

test("文字宣称完成和错误产物都不能误判为通过", async () => {
  for (const settings of [{ textOnly: true }, { wrongResult: true }]) {
    const mock = createDevelopmentProvider(settings);
    const result = await runProviderDevelopment({ provider, model: "mock", fetchImpl: mock.fetchImpl });
    assert.equal(result.outcome, "failed"); assert.notEqual(result.results.at(-1).outcome, "passed");
  }
});

test("超出轮数、总时间、网络、额度和输出预算只能判定未完成", async () => {
  const mock = createDevelopmentProvider();
  assert.equal((await runProviderDevelopment({ provider, model: "mock", fetchImpl: mock.fetchImpl, maxRequests: 1 })).outcome, "inconclusive");
  const timeout = await runProviderDevelopment({ provider, model: "mock", totalTimeoutMs: 15, fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => { if (signal.aborted) reject(new Error("aborted")); else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }) });
  assert.equal(timeout.outcome, "inconclusive");
  for (const status of [403, 429, 503]) assert.equal((await runProviderDevelopment({ provider, model: "mock", fetchImpl: async () => new Response("private secret", { status }) })).outcome, "inconclusive");
  assert.equal((await runProviderDevelopment({ provider, model: "mock", fetchImpl: async () => { throw new Error("network private secret"); } })).outcome, "inconclusive");
  for (const type of ["response.completed", "response.incomplete"]) assert.equal((await runProviderDevelopment({ provider, model: "mock", fetchImpl: async () => new Response(`data: ${JSON.stringify({ type, response: { status: "incomplete", output: [] } })}\n\n`, { headers: { "content-type": "text/event-stream" } }) })).outcome, "inconclusive");
});

test("缺少 call_id、重复调用、模型不符和截断流不能通过", async () => {
  for (const output of [[{ type: "function_call", name: "read_file", arguments: "{}" }], [{ type: "function_call", name: "read_file", arguments: "{}", call_id: "a" }, { type: "function_call", name: "read_file", arguments: "{}", call_id: "a" }]]) {
    const result = await runProviderDevelopment({ provider, model: "mock", fetchImpl: async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", model: "mock", output } })}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
    assert.equal(result.outcome, "failed"); assert.equal(result.steps.length, 0);
  }
  const truncated = await runProviderDevelopment({ provider, model: "mock", fetchImpl: async () => new Response('data: {"type":"response.output_text.delta","delta":"Done"}\n\n', { headers: { "content-type": "text/event-stream" } }) });
  assert.equal(truncated.outcome, "failed");
  const mapped = createDevelopmentProvider(); assert.equal((await runProviderDevelopment({ provider: { ...provider, modelMap: { alias: "mapped" } }, model: "alias", fetchImpl: mapped.fetchImpl })).outcome, "passed");
  assert.ok(mapped.requests.every((item) => item.model === "mapped"));
});

test("取消在途请求后停止后续调用，报告不包含上游正文或认证", async () => {
  const controller = new AbortController();
  const result = await runProviderDevelopment({ provider, model: "mock", signal: controller.signal, fetchImpl: async (_url, { signal }) => { controller.abort(); signal.throwIfAborted(); } });
  assert.equal(result.outcome, "cancelled"); assert.equal(result.requestCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /never-report|private secret/);
});

test("工具执行器拒绝越界、任意命令、软链接、超限与多次替换，并清理本次目录", async () => {
  const task = await createDevelopmentTask();
  try {
    for (const [name, args] of [
      ["read_file", { path: "../secret" }], ["read_file", { path: "task-check.mjs" }],
      ["write_file", { path: "input.json", content: "overwritten" }], ["write_file", { path: "result.json", content: "a".repeat(65537) }],
      ["run_command", { command: "node task-check.mjs inspect; env" }], ["run_command", { command: "node -e 'process.exit()'" }], ["run_command", { command: "toString" }],
      ["edit_file", { path: "summary.json", old_text: " ", new_text: "x" }], ["edit_file", { path: "summary.json", old_text: "missing", new_text: "x" }],
      ["read_file", { path: "input.json", extra: "x" }], ["unknown", {}],
    ]) assert.equal((await task.execute(name, args)).ok, false);
    await symlink(path.join(task.directory, "input.json"), path.join(task.directory, "result.json"));
    assert.equal((await task.execute("read_file", { path: "result.json" })).ok, false);
    assert.equal((await task.execute("write_file", { path: "result.json", content: "{}" })).ok, false);
    assert.equal((await task.execute("run_command", { command: "node task-check.mjs verify" })).ok, false);
    assert.equal(await task.verify(), false);
    assert.match(await readFile(path.join(task.directory, "input.json"), "utf8"), /nonce/);
    await writeFile(path.join(task.directory, "task-check.mjs"), "process.exit(0)");
    assert.equal((await task.execute("run_command", { command: "node task-check.mjs inspect" })).ok, false);
  } finally { await task.cleanup(); }
  await assert.rejects(access(task.directory));
});

test("受控子进程也受到时间与取消预算约束", async () => {
  const task = await createDevelopmentTask({ commandTimeoutMs: 1 });
  try { const result = await task.execute("run_command", { command: "node task-check.mjs inspect" }); assert.equal(result.ok, false); assert.equal(result.environmentError, true); }
  finally { await task.cleanup(); }
  const controller = new AbortController(); const cancelled = await createDevelopmentTask({ signal: controller.signal });
  try { controller.abort(); await assert.rejects(cancelled.execute("run_command", { command: "node task-check.mjs inspect" })); }
  finally { await cancelled.cleanup(); }
});
