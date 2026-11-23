/** 手动开发任务检查：固定供应商完成多轮受控工具任务，不修改路由和恢复状态。 */
import { createCompatibilityRequester } from "./compatibility-request.js";
import { createDevelopmentTask, DEVELOPMENT_PROMPT, DEVELOPMENT_TOOLS } from "./development-task.js";

const labels = { read: "读取随机输入", command: "执行预置命令", create: "创建结果文件", edit: "修改并保留原字段", verify: "命令校验通过", independent: "独立检查产物" };
function describeToolStep(tool, args, result) {
  // 固定目标字段便于诊断，即使调用失败，也不记录模型提交的任意路径、命令或文件正文。
  const file = ["input.json", "summary.json", "result.json"].includes(args?.path) ? args.path : "";
  const command = args?.command === "node task-check.mjs inspect" ? "inspect" : args?.command === "node task-check.mjs verify" ? "verify" : "";
  const target = tool === "run_command" ? command : ["read_file", "write_file", "edit_file"].includes(tool) ? file : "";
  if (!result.ok) return { target, detail: result.exitCode === 1 && target === "verify"
    ? "校验程序发现产物内容不符合任务要求。"
    : "工具参数未通过校验，或本地操作没有完成。" };
  const detail = {
    read_file: "已读取合成任务文件并将结果回传。",
    write_file: "已写入结果文件，内容是否正确由后续校验判断。",
    edit_file: "完成了指定文本替换，字段是否保留由后续校验判断。",
    run_command: target === "verify" && result.output === "VERIFIED" ? "校验程序返回 VERIFIED。" : "预置 inspect 命令返回了合成校验码。",
  }[tool];
  return { target, detail };
}
export async function runProviderDevelopment(options) {
  const { provider, model, signal, totalTimeoutMs = 120_000, maxRequests = 8 } = options;
  const startedAt = Date.now(); const checkedAt = new Date(startedAt).toISOString();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, totalTimeoutMs);
  const base = { model, stream: true, store: false, instructions: "", tools: DEVELOPMENT_TOOLS, tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 1024 };
  if (["oauth_file", "client_session"].includes(provider.authMode)) base.include = ["reasoning.encrypted_content"];
  const transport = createCompatibilityRequester({ ...options, signal: controller.signal, remainingMs: () => totalTimeoutMs - (Date.now() - startedAt), base });
  const steps = []; const seenCallIds = new Set(); let task; let outcome = "inconclusive"; let message = "达到请求次数预算，任务未完成";
  let independent = false;
  try {
    controller.signal.throwIfAborted();
    task = await createDevelopmentTask({ signal: controller.signal });
    const input = [{ role: "user", content: [{ type: "input_text", text: DEVELOPMENT_PROMPT }] }];
    while (transport.requestCount < maxRequests) {
      controller.signal.throwIfAborted();
      const response = await transport.request(`development-${transport.requestCount + 1}`, { input });
      if (response.error) { outcome = response.errorKind; message = response.error; break; }
      if (!response.isSse) { outcome = "failed"; message = "请求流式响应，上游实际返回 JSON"; break; }
      const calls = response.payload.output.filter((item) => item.type === "function_call");
      if (calls.length > 16 || calls.some((call) => typeof call.call_id !== "string" || !call.call_id || call.call_id.length > 200 || seenCallIds.has(call.call_id)) || new Set(calls.map((call) => call.call_id)).size !== calls.length) {
        outcome = "failed"; message = "工具调用过多、缺少或重复 call_id"; break;
      }
      input.push(...response.payload.output);
      for (const call of calls) {
        controller.signal.throwIfAborted(); seenCallIds.add(call.call_id);
        let result; let args;
        try { args = JSON.parse(call.arguments); result = await task.execute(call.name, args); }
        catch (error) { if (controller.signal.aborted) throw error; result = { ok: false, error: "工具参数不是合法 JSON 对象" }; }
        const description = describeToolStep(call.name, args, result);
        steps.push({ round: transport.requestCount, tool: DEVELOPMENT_TOOLS.some((tool) => tool.name === call.name) ? call.name : "unknown",
          ok: result.ok, target: description.target, detail: description.detail, exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
          message: result.ok ? "实际操作成功" : "操作未成功，已回传可修正的错误" });
        if (result.environmentError) throw new Error("本地命令未完成");
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
      }
      independent = await task.verify();
      if (Object.values(task.evidence).every(Boolean) && independent) { outcome = "passed"; message = "完成真实文件读写、受控命令与独立校验"; break; }
      if (!calls.length) { outcome = "failed"; message = "模型停止调用工具，但任务操作或产物校验尚未完成"; break; }
    }
  } catch {
    outcome = signal?.aborted ? "cancelled" : "inconclusive";
    message = signal?.aborted ? "检查已取消" : controller.signal.aborted ? "达到总时间预算，任务未完成" : "本地任务环境无法完成检查";
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort();
    await task?.cleanup();
  }
  if (signal?.aborted) { outcome = "cancelled"; message = "检查已取消"; }
  else if (controller.signal.aborted && Date.now() - startedAt >= totalTimeoutMs && outcome !== "passed") { outcome = "inconclusive"; message = "达到总时间预算，任务未完成"; }
  const evidence = { ...task?.evidence, independent };
  return { providerId: provider.id, model, mode: "development", checkedAt, requestCount: transport.requestCount, outcome, message,
    budget: { totalTimeoutMs, maxRequests, maxOutputTokens: 1024 }, latencyMs: Date.now() - startedAt, steps, requestTrace: transport.trace,
    results: Object.entries(labels).map(([key, label]) => ({ key, outcome: evidence[key] ? "passed" : "skipped", message: label + (evidence[key] ? "：已验证" : "：未取得成功证据") })), routingEffect: "none" };
}
