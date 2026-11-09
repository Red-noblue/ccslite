/**
 * 中文前置器终端日志过滤测试：高频明细静默，生命周期与错误仍可见。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { shouldPrintHandoffLog } from "../../lib/handoff-terminal-log.js";

test("默认隐藏高频交接明细", () => {
  for (const event of ["handoff_request_finished", "handoff_usage_committed", "handoff_config_committed", "handoff_sessions_drained"]) {
    assert.equal(shouldPrintHandoffLog(JSON.stringify({ event })), false, event);
  }
});

test("生命周期事件、普通错误和 verbose 模式仍可见", () => {
  assert.equal(shouldPrintHandoffLog(JSON.stringify({ event: "handoff_activated" })), true);
  assert.equal(shouldPrintHandoffLog("候选版本启动失败"), true);
  assert.equal(shouldPrintHandoffLog(JSON.stringify({ event: "handoff_usage_committed" }), { verbose: true }), true);
});
