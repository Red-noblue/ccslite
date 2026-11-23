/** 手动编码兼容性检查：最多五次合成请求；不修改供应商健康、模型证据或会话粘滞。 */
import crypto from "node:crypto";
import { createCompatibilityRequester } from "./compatibility-request.js";

const outputText = (response) => (response?.output || []).flatMap((item) => item.content || [])
  .filter((item) => item.type === "output_text").map((item) => item.text || "").join("");
const userInput = (text) => [{ role: "user", content: [{ type: "input_text", text }] }];

export async function runProviderCompatibility(options) {
  const { provider, model, signal } = options;
  const checkedAt = new Date().toISOString();
  const results = [];
  const base = { model, stream: true, store: false, instructions: "", tools: [], parallel_tool_calls: false, max_output_tokens: 256 };
  if (["oauth_file", "client_session"].includes(provider.authMode)) base.include = ["reasoning.encrypted_content"];

  const transport = createCompatibilityRequester({ ...options, base });
  const { request } = transport;

  async function check(key, action) {
    const startedAt = Date.now();
    if (signal?.aborted) { results.push({ key, outcome: "skipped", message: "检查已取消", latencyMs: 0 }); return; }
    try {
      const message = await action();
      results.push({ key, outcome: "passed", message, latencyMs: Date.now() - startedAt });
    } catch (error) {
      results.push({ key, outcome: "failed", message: error.message, latencyMs: Date.now() - startedAt });
    }
  }
  const requireResponse = (response) => { if (response.error) throw new Error(response.error); return response.payload; };

  await check("stream", async () => {
    const response = await request("stream", { input: userInput("Reply with CCOK only.") });
    const payload = requireResponse(response);
    if (!response.isSse) throw new Error("请求流式响应，上游实际返回 JSON");
    if (!outputText(payload).includes("CCOK")) throw new Error("流式结束，但回答不符合合成检查要求");
    return "收到 SSE 与完整结束事件";
  });

  await check("tools", async () => {
    const input = userInput("Call ccslite_compat_ping once. Then reply with the exact code returned by that function, without any other text.");
    const tools = [{ type: "function", name: "ccslite_compat_ping", description: "Return a synthetic test code; no external effects.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true }];
    const first = requireResponse(await request("tool_call", { input, tools, tool_choice: { type: "function", name: "ccslite_compat_ping" } }));
    const calls = (first.output || []).filter((item) => item.type === "function_call");
    if (calls.length !== 1 || calls[0].name !== "ccslite_compat_ping" || !calls[0].call_id) throw new Error("未返回预期的 function_call 和 call_id");
    let argumentsObject;
    try { argumentsObject = JSON.parse(calls[0].arguments); } catch { throw new Error("工具调用参数不是合法 JSON"); }
    if (!argumentsObject || Array.isArray(argumentsObject) || typeof argumentsObject !== "object" || Object.keys(argumentsObject).length) throw new Error("工具参数不符合空对象定义");
    const marker = `TOOL_${crypto.randomBytes(6).toString("hex")}`;
    const next = requireResponse(await request("tool_result", { tools, tool_choice: "none", input: [...input, ...first.output, { type: "function_call_output", call_id: calls[0].call_id, output: marker }] }));
    if (!outputText(next).includes(marker)) throw new Error("工具结果已提交，但回答没有使用工具返回的合成代码");
    return "工具调用与结果回传成功；未执行真实工具";
  });

  await check("context", async () => {
    const marker = `CTX_${crypto.randomBytes(6).toString("hex")}`;
    const first = requireResponse(await request("context_create", { store: true, input: userInput(`Remember this code: ${marker}. Reply with OK only.`) }));
    if (!first.id) throw new Error("上游未返回响应 ID");
    const next = requireResponse(await request("context_continue", { store: true, previous_response_id: first.id, input: userInput("What was the code in the previous user message? Reply with that exact code only.") }));
    if (!outputText(next).includes(marker)) throw new Error("续接请求成功，但未保留上一轮合成上下文");
    return "previous_response_id 续接且上下文内容一致";
  });

  return { providerId: provider.id, model, checkedAt, requestCount: transport.requestCount, results, requestTrace: transport.trace, routingEffect: "none" };
}
