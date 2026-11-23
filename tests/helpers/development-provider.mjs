/** 本地开发能力模拟上游：根据真实工具返回构造下一轮调用，不接触任何外部供应商。 */
import assert from "node:assert/strict";
export function createDevelopmentProvider({ textOnly = false, repair = false, wrongResult = false, repairResult = false } = {}) {
  const requests = [];
  function respond(body) {
    requests.push(body);
    assert.equal(body.store, false); assert.equal(body.previous_response_id, undefined); assert.equal(body.tool_choice, "auto");
    const outputs = body.input.filter((item) => item.type === "function_call_output");
    const lookup = (name) => outputs.filter((item) => body.input.some((call) => call.type === "function_call" && call.name === name && call.call_id === item.call_id)).map((item) => JSON.parse(item.output));
    const successful = (name) => lookup(name).find((item) => item.ok);
    const call = (name, args, index = 0) => ({ type: "function_call", name, call_id: `call-${requests.length}-${index}`, arguments: JSON.stringify(args) });
    if (textOnly) return [{ type: "message", content: [{ type: "output_text", text: "Done, all files were created and verified." }] }];
    if (repair && requests.length === 1) return [call("read_file", { path: "../../private" })];
    const readValues = lookup("read_file").filter((item) => item.ok).map((item) => JSON.parse(item.content));
    const input = readValues.find((item) => item.nonce);
    const summary = readValues.find((item) => item.preserved);
    if (!input || !summary) return [call("read_file", { path: "input.json" }), call("read_file", { path: "summary.json" }, 1)];
    const command = successful("run_command");
    if (!command) return [call("run_command", { command: "node task-check.mjs inspect" })];
    const verifyFailed = lookup("run_command").some((item) => item.exitCode === 1);
    if (!successful("write_file") || repairResult && verifyFailed && lookup("write_file").length === 1) {
      const result = { nonce: input.nonce, total: input.left + input.right + (wrongResult || repairResult && !verifyFailed ? 1 : 0), commandCode: JSON.parse(command.output).commandCode };
      return [call("write_file", { path: "result.json", content: JSON.stringify(result) }), call("edit_file", { path: "summary.json", old_text: successful("edit_file") ? JSON.stringify({ ...summary, status: "done", total: input.left + input.right }) : JSON.stringify(summary, null, 2), new_text: JSON.stringify({ ...summary, status: "done", total: input.left + input.right }) }, 1)];
    }
    if (!lookup("run_command").some((item) => item.output === "VERIFIED") && (!verifyFailed || repairResult && lookup("write_file").length > 1)) return [call("run_command", { command: "node task-check.mjs verify" })];
    return [{ type: "message", content: [{ type: "output_text", text: "Done" }] }];
  }
  function stream(body, output) {
    const response = { id: `resp-${requests.length}`, status: "completed", model: body.model, output, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
    return output.filter((item) => item.type === "function_call").map((item) => `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: item.call_id, delta: item.arguments.slice(0, 5) })}\n\n`).join("") + `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
  }
  return { requests, respond, stream, fetchImpl: async (_url, { body: raw }) => {
    const body = JSON.parse(raw.toString()); const bytes = new TextEncoder().encode(stream(body, respond(body)));
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 13)); controller.enqueue(bytes.slice(13, 83)); controller.enqueue(bytes.slice(83)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  } };
}
