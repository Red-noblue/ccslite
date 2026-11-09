/** 中文 IPC 故障测试：并发乱序、超时、迟到回复和断开均释放共享监听器。 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createHandoffRpc } from "../../lib/handoff-rpc.js";
function connection() {
  const peer = new EventEmitter(); peer.connected = true; peer.messages = [];
  peer.send = (message, callback) => { peer.messages.push(message); callback?.(); };
  return peer;
}
test("100 个并发 IPC 仅注册一套监听器，乱序确认正确并全部释放", async () => {
  const peer = connection(); const rpc = createHandoffRpc(peer);
  const tasks = Array.from({ length: 100 }, (_, n) => rpc.request("write", { n, requestId: "不能覆盖内部编号" }));
  assert.equal(peer.listenerCount("message"), 1); assert.equal(peer.listenerCount("disconnect"), 1);
  for (const item of [...peer.messages].reverse()) peer.emit("message", { type: "handoff_control_result", requestId: item.requestId, result: item.n });
  assert.deepEqual(await Promise.all(tasks), Array.from({ length: 100 }, (_, n) => n));
  assert.equal(rpc.state().pending, 0); assert.equal(peer.listenerCount("message"), 0);
});
test("无确认、发送失败和断开均结束等待，迟到确认不会污染下一次调用", async () => {
  const peer = connection(); const rpc = createHandoffRpc(peer, { timeoutMs: 10 });
  await assert.rejects(rpc.request("timeout"), { code: "handoff_ipc_timeout" });
  peer.emit("message", { type: "handoff_control_result", requestId: peer.messages[0].requestId, result: "迟到" });
  const waiting = rpc.request("disconnect"); peer.emit("disconnect");
  await assert.rejects(waiting, { code: "handoff_ipc_disconnected" });
  peer.send = () => { throw new Error("发送失败"); };
  await assert.rejects(rpc.request("send"), /发送失败/);
  assert.equal(rpc.state().pending, 0); assert.equal(peer.listenerCount("exit"), 0);
});
