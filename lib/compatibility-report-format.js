/** 检查报告格式：固定版本的检查定义与脱敏导出白名单，可在服务端和浏览器中复用。 */
const keys = { basic: ["stream", "tools", "context"], development: ["read", "command", "create", "edit", "verify", "independent"] };
const outcomes = ["passed", "failed", "inconclusive", "cancelled", "skipped"];
const tools = ["read_file", "write_file", "edit_file", "run_command", "unknown"];
const traceSteps = new Set(["stream", "tool_call", "tool_result", "context_create", "context_continue"]);
const traceOutcomes = new Set(["completed", "failed", "inconclusive", "cancelled"]);
const version = (value) => typeof value === "string" && /^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value) ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const outcome = (value) => outcomes.includes(value) ? value : "inconclusive";

export function createCompatibilityMetadata(mode, environment) {
  return {
    schemaVersion: 1,
    definition: { id: `ccslite.responses.${mode}`, version: 1, protocol: "openai-responses", capabilities: [...keys[mode]] },
    environment: { ...environment },
  };
}

export function getCompatibilityDefinition(report) {
  const definition = report.definition;
  if (report.schemaVersion !== 1 || !keys[report.mode] || definition?.id !== `ccslite.responses.${report.mode}` || definition.version !== 1 || definition.protocol !== "openai-responses") return null;
  return { id: definition.id, version: 1, protocol: "openai-responses", capabilities: [...keys[report.mode]] };
}

export function exportCompatibilityReport(report) {
  const mode = keys[report.mode] ? report.mode : null;
  const definition = getCompatibilityDefinition(report);
  const results = (Array.isArray(report.results) ? report.results : []).filter((item) => keys[mode]?.includes(item?.key))
    .map((item) => ({ key: item.key, outcome: outcome(item.outcome), latencyMs: count(item.latencyMs) }));
  const verified = definition && mode === "development" && report.outcome === "passed" && report.requestCount > 0 && keys.development.every((key) => results.filter((item) => item.key === key).length === 1 && results.find((item) => item.key === key).outcome === "passed");
  const checkedAt = typeof report.checkedAt === "string" && Number.isFinite(Date.parse(report.checkedAt)) ? new Date(report.checkedAt).toISOString() : null;
  return {
    format: "ccslite-readiness-report", formatVersion: 1,
    mode, model: typeof report.model === "string" ? report.model.slice(0, 160) : null, checkedAt,
    definition,
    environment: report.environment ? {
      ccsliteVersion: version(report.environment.ccsliteVersion), nodeVersion: version(report.environment.nodeVersion),
      platform: ["aix", "android", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"].includes(report.environment.platform) ? report.environment.platform : null,
      arch: ["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc64", "riscv64", "s390x", "x64"].includes(report.environment.arch) ? report.environment.arch : null,
    } : null,
    configuration: report.stale === true ? "changed" : report.stale === false ? "matches" : "unknown",
    outcome: outcome(report.outcome),
    readiness: mode === "basic" ? "not_assessed" : verified ? "verified_for_this_task" : "not_verified",
    requestCount: count(report.requestCount), latencyMs: count(report.latencyMs),
    usage: { inputTokens: count(report.usage?.inputTokens), outputTokens: count(report.usage?.outputTokens), totalTokens: count(report.usage?.totalTokens) },
    budget: Object.fromEntries(["maxRequests", "totalTimeoutMs", "requestTimeoutMs", "maxOutputTokens", "maxResponseBytes"].map((key) => [key, count(report.budget?.[key])])),
    results,
    requestTrace: (Array.isArray(report.requestTrace) ? report.requestTrace : []).slice(0, 12).map((item, index) => ({
      sequence: count(item?.sequence) ?? index + 1,
      step: traceSteps.has(item?.step) || /^development-\d{1,2}$/.test(item?.step || "") ? item.step : "unknown",
      protocol: ["sse", "json", "other"].includes(item?.protocol) ? item.protocol : "unknown",
      statusCode: count(item?.statusCode), responseBytes: count(item?.responseBytes), firstByteMs: count(item?.firstByteMs), latencyMs: count(item?.latencyMs),
      outcome: traceOutcomes.has(item?.outcome) ? item.outcome : "inconclusive",
    })),
    steps: (Array.isArray(report.steps) ? report.steps : []).map((step) => ({
      round: count(step?.round), tool: tools.includes(step?.tool) ? step.tool : "unknown", ok: step?.ok === true,
      target: ["input.json", "summary.json", "result.json", "inspect", "verify"].includes(step?.target) ? step.target : "",
      exitCode: count(step?.exitCode),
    })),
    scope: mode === "development" ? "隔离文件内的真实读写、两条固定 Node 命令和独立产物校验" : mode === "basic" ? "SSE 完整结束、合成函数往返和 previous_response_id 续接" : "历史报告未记录检查范围",
    limitations: ["结果仅对应本次模型、配置和受控任务，不代表完整兼容任何开发客户端。", "未执行真实 Codex 或 OpenCode 客户端验收，也不证明任意断流都能无损恢复。", "保留模型名称、检查时间和环境版本；不导出供应商标识、地址、认证、配置指纹、原始正文或动态错误文本。"],
    routingEffect: "none",
  };
}
