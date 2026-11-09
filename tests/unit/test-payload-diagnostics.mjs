/**
 * 413 诊断状态机测试。
 * 验证显式 arm 只消费一次，且后台诊断不阻塞主请求。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createPayloadDiagnostics } from "../../lib/payload-diagnostics.js";

test("413 诊断只捕获一次并在后台记录结果", async () => {
  const records = [];
  const diagnostics = createPayloadDiagnostics({
    runDiagnostic: async ({ body }) => ({ bytes: body.length }),
    append: async (_path, line) => records.push(JSON.parse(line)),
    makeDir: async () => {},
    logPath: "/tmp/diagnostics.jsonl",
  });
  assert.equal(diagnostics.arm(), true);
  assert.equal(diagnostics.arm(), false);
  assert.equal(await diagnostics.capture({ body: Buffer.from("large") }), true);
  assert.equal(await diagnostics.capture({ body: Buffer.from("ignored") }), false);
  for (let i = 0; i < 20 && diagnostics.status().running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(diagnostics.status().armed, false);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].bytes, 5);
});

test("诊断排空等待包含日志写入，完成前不能再次触发", async () => {
  let releaseAppend;
  let appendStarted;
  const started = new Promise((resolve) => { appendStarted = resolve; });
  const diagnostics = createPayloadDiagnostics({
    logPath: "/tmp/diagnostics.jsonl", makeDir: async () => {},
    runDiagnostic: async () => ({ bytes: 5 }),
    append: async () => { appendStarted(); await new Promise((resolve) => { releaseAppend = resolve; }); },
  });
  diagnostics.arm(); await diagnostics.capture({ body: Buffer.from("large") }); await started;
  assert.equal(diagnostics.status().running, true);
  assert.equal(diagnostics.arm(), false);
  let flushed = false;
  const flushing = diagnostics.flush().then(() => { flushed = true; });
  await Promise.resolve(); assert.equal(flushed, false);
  releaseAppend(); await flushing;
  assert.equal(diagnostics.status().running, false);
  assert.equal(diagnostics.arm(), true);
});
