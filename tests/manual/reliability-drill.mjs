/** 可重复故障演练：复用隔离测试输出中文结果与 JSON 证据，仅使用本机模拟上游和独立数据。 */
import { run } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--json") || args.length > 1) throw new Error("用法：node tests/manual/reliability-drill.mjs [--json]");
const jsonOnly = args.includes("--json");
const startedAt = new Date().toISOString(); const started = Date.now();
const info = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const scenarios = [
  { id: "pre_output_failover", name: "有效输出前断流后切换，备用响应完整结束" },
  { id: "post_output_boundary", name: "输出后断流明确失败，禁止拼接另一供应商" },
  { id: "recovery_migration", name: "同模型两次成功确认，绑定回迁并实际使用优先供应商" },
  { id: "session_upgrade", name: "并行会话按请求逐步升级，旧流正常完成" },
  { id: "fixed_fallback", name: "固定备份接管，三个旧流完成且用量不重放" },
];
const files = ["test-stream-failover-before-output.mjs", "test-business-recovery.mjs", "test-handoff-session.mjs", "test-handoff-fixed-fallback.mjs"];
const evidence = new Map(); const tests = []; const failures = [];
if (!jsonOnly) console.log("本机模拟故障演练：不会请求真实供应商或操作生产实例。正在依次验证断流、回迁、升级和回退…");
for await (const event of run({ files: files.map((name) => path.join(root, "tests/integration", name)), concurrency: 1 })) {
  if (event.type === "test:diagnostic") {
    try { const value = JSON.parse(event.data.message); if (value.simulated === true && scenarios.some((scenario) => scenario.id === value.scenario)) evidence.set(value.scenario, value); } catch { /* 非场景诊断不进入报告。 */ }
  }
  if (["test:pass", "test:fail"].includes(event.type) && event.data.nesting === 0) {
    const item = { name: event.data.name, passed: event.type === "test:pass", durationMs: event.data.details?.duration_ms ?? null };
    tests.push(item); if (!item.passed) failures.push(item.name);
    if (!jsonOnly) console.log(`${item.passed ? "通过" : "失败"}：${item.name}`);
  }
}
const result = { format: "ccslite-reliability-drill", formatVersion: 1, simulated: true, realSupplierRequests: 0,
  ccsliteVersion: info.version, nodeVersion: process.version, startedAt, durationMs: Date.now() - started,
  passed: failures.length === 0 && tests.length > 0 && scenarios.every((scenario) => evidence.has(scenario.id)),
  scenarios: scenarios.map((scenario) => ({ ...scenario, evidence: evidence.get(scenario.id) || null })), tests,
  limitations: ["这是本机模拟场景验收，不能代替真实供应商或真实客户端验收。", "输出后的断流被记录为失败；未声称无损恢复或任意情况下零中断。"] };
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
