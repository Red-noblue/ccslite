/**
 * 中文版本交接状态机测试：验证候选失败恢复、排空后切换、租约失败和运行中回退。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHandoffCoordinator, DEFAULT_HANDOFF_DRAIN_TIMEOUT_MS } from "../../lib/handoff-coordinator.js";
import { createHandoffQueue } from "../../lib/handoff-queue.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("旧版本排空默认等待五分钟，避免长对话过早取消升级", () => {
  assert.equal(DEFAULT_HANDOFF_DRAIN_TIMEOUT_MS, 300_000);
});

function fixture(overrides = {}) {
  const events = []; const calls = []; const leases = []; let active = 0;
  const workers = new Map([["old", { id: "old" }], ["new", { id: "new" }]]);
  const queue = createHandoffQueue({ maxWaitMs: 500, onEvent: (event) => events.push(event) });
  const coordinator = createHandoffCoordinator({ queue,
    startCandidate: async (worker) => { if (worker.failStart) throw new Error("候选启动失败"); return worker; },
    checkCandidate: async (worker) => { if (worker.failCheck) throw new Error("候选健康检查失败"); },
    stopCandidate: async (worker) => { worker.stopped = true; },
    acquireWriteLease: async (worker) => { if (worker.failLease) throw new Error("租约冲突"); leases.push(`acquire:${worker.id}`); },
    releaseWriteLease: async (worker) => leases.push(`release:${worker.id}`),
    dispatch: async (worker, request) => { calls.push([worker.id, request.id]); return worker.id; },
    getActiveRequests: async () => active,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  coordinator.setCurrent(workers.get("old"));
  queue.activate((request) => coordinator.state().current === "old" ?
    Promise.resolve().then(() => { calls.push(["old", request.id]); return "old"; }) : Promise.resolve("unexpected"));
  return { queue, coordinator, events, calls, leases, workers, setActive: (value) => { active = value; } };
}

test("候选预热失败时不进入排空，当前版本继续处理新请求", async () => {
  const f = fixture(); const bad = { id: "bad", failStart: true };
  await assert.rejects(f.coordinator.upgrade(bad), /候选启动失败/);
  assert.deepEqual(f.coordinator.state(), { phase: "active", current: "old", previous: null });
  assert.equal(await f.queue.route({ id: 1 }), "old"); assert.deepEqual(f.calls, [["old", 1]]);
});

test("旧版本排空后转移租约，排队请求只交给新版本", async () => {
  const f = fixture(); f.setActive(1); const upgrade = f.coordinator.upgrade({ id: "new" }); await pause(10); const pending = f.queue.route({ id: 1 });
  assert.equal(f.coordinator.state().phase, "draining"); assert.equal(f.queue.stats().queuedRequests, 1);
  f.setActive(0); await upgrade; assert.equal(await pending, "new");
  assert.deepEqual(f.coordinator.state(), { phase: "active", current: "new", previous: "old" });
  assert.deepEqual(f.leases, ["release:old", "acquire:new"]); assert.deepEqual(f.calls, [["new", 1]]);
});

test("多个旧请求按完成进度排空，但必须全部完成后才交出写入租约", async () => {
  const f = fixture({ idlePollMs: 1 });
  f.setActive(2);
  const upgrade = f.coordinator.upgrade({ id: "new" });
  await pause(5);
  const pending = f.queue.route({ id: 7 });
  f.setActive(1);
  await Promise.race([
    pending.then(() => { throw new Error("仍有旧请求时不应提前放行新版本"); }),
    pause(15),
  ]);
  assert.equal(f.coordinator.state().phase, "draining");
  assert.equal(f.queue.stats().queuedRequests, 1);
  f.setActive(0);
  await upgrade;
  assert.equal(await pending, "new");
  assert.deepEqual(f.leases, ["release:old", "acquire:new"]);
});

test("租约转移失败时恢复当前版本并释放排队请求", async () => {
  const f = fixture(); f.setActive(0); const upgrade = f.coordinator.upgrade({ id: "new", failLease: true }); const rejected = assert.rejects(upgrade, /租约冲突/); await pause(10); const pending = f.queue.route({ id: 2 });
  await rejected;
  assert.equal(await pending, "old"); assert.deepEqual(f.coordinator.state(), { phase: "active", current: "old", previous: null });
});

test("候选接管后恢复到指定备份，不把上一进程自动作为回退目标", async () => {
  const f = fixture(); f.setActive(0); await f.coordinator.upgrade(f.workers.get("new"));
  await f.coordinator.recover({ id: "fixed" }, "候选进程退出");
  assert.equal(await f.queue.route({ id: 3 }), "fixed");
  assert.deepEqual(f.coordinator.state(), { phase: "active", current: "fixed", previous: null });
  assert.ok(f.workers.get("new")?.stopped); assert.ok(f.events.some((event) => event.event === "handoff_recovery_completed"));
});

test("关闭交接时排队请求全部结束，不能留下定时器", async () => {
  const f = fixture(); f.queue.beginDrain(); const pending = f.queue.route({ id: 4 }); f.coordinator.close();
  await assert.rejects(pending, (error) => error.code === "handoff_closed"); assert.equal(f.queue.stats().queuedRequests, 0);
});

test("候选激活失败后重新获取旧版本租约，排队请求回到旧版本", async () => {
  const activations = []; const f = fixture({ onActivated: async (worker) => { activations.push(worker.id); if (worker.id === "new") throw new Error("激活失败"); } });
  await assert.rejects(f.coordinator.upgrade(f.workers.get("new")), /激活失败/);
  assert.deepEqual(activations, ["new", "old"]);
  assert.deepEqual(f.leases, ["release:old", "acquire:new", "acquire:old"]);
  assert.deepEqual(f.coordinator.state(), { phase: "active", current: "old", previous: null });
  assert.equal(await f.queue.route({ id: 5 }), "old");
});

test("候选与旧版本均无法激活时进入故障状态，不能假报已经恢复", async () => {
  const f = fixture({ onActivated: async () => { throw new Error("激活失败"); } });
  await assert.rejects(f.coordinator.upgrade(f.workers.get("new")), /旧版本恢复失败/);
  assert.equal(f.coordinator.state().phase, "failed");
  assert.equal(f.queue.state(), "closed");
});

test("观察中的旧进程不能被下一次升级静默覆盖", async () => {
  const f = fixture(); await f.coordinator.upgrade({ id: "new" });
  await assert.rejects(f.coordinator.upgrade({ id: "next" }), (error) => error.status === 409);
  assert.deepEqual(f.coordinator.state(), { phase: "active", current: "new", previous: "old" });
});

test("旧进程已经退役时，可以重新启动回退包接管排队请求", async () => {
  const f = fixture(); await f.coordinator.upgrade({ id: "new" }); await f.coordinator.retirePrevious();
  const worker = await f.coordinator.recover({ id: "cold-old" }, "当前进程退出");
  assert.equal(worker.id, "cold-old"); assert.equal(await f.queue.route({ id: 6 }), "cold-old");
  assert.deepEqual(f.coordinator.state(), { phase: "active", current: "cold-old", previous: null });
  assert.ok(f.events.some((event) => event.event === "handoff_recovery_completed"));
});

test("重新启动回退包失败时明确报告故障，不假报恢复", async () => {
  const f = fixture(); await assert.rejects(f.coordinator.recover({ id: "bad", failStart: true }), /候选启动失败/);
  assert.equal(f.coordinator.state().phase, "failed"); assert.equal(f.queue.state(), "closed");
});

test("并行交接中回退到固定备份，备份接管后才停止原有进程", async () => {
  const order = [];
  let ready;
  const gate = new Promise((resolve) => { ready = resolve; });
  const f = fixture({
    startCandidate: async (worker) => { if (worker.id === "fixed") await gate; return worker; },
    prepareContinuation: async (worker) => order.push(`prepare:${worker.id}`),
    onActivated: async (worker) => order.push(`activate:${worker.id}`),
    stopCandidate: async (worker) => order.push(`stop:${worker.id}`),
  });
  await f.coordinator.upgradeSession({ id: "new" });
  const recovery = f.coordinator.recover({ id: "fixed" }, "固定备份回退", { prepareCurrent: true });
  await pause(5);
  const pending = f.queue.route({ id: 8 });
  assert.equal(f.queue.stats().queuedRequests, 1);
  assert.ok(!order.some((call) => call.startsWith("stop:")));
  ready();
  await recovery;
  assert.equal(await pending, "fixed");
  await pause(0);
  assert.ok(order.indexOf("activate:fixed") < order.indexOf("stop:new"));
  assert.ok(order.indexOf("activate:fixed") < order.indexOf("stop:old"));
  assert.ok(order.includes("prepare:new"));
  assert.deepEqual(f.coordinator.state(), { phase: "active", current: "fixed", previous: null });
});

test("会话交接旧版本退役后恢复 active，并允许再次升级", async () => {
  const f = fixture();
  await f.coordinator.upgradeSession({ id: "new" });
  assert.deepEqual(f.coordinator.state(), { phase: "active_parallel", current: "new", previous: "old" });
  assert.equal(await f.coordinator.retirePrevious(), true);
  assert.deepEqual(f.coordinator.state(), { phase: "active", current: "new", previous: null });

  await f.coordinator.upgradeSession({ id: "next" });
  assert.deepEqual(f.coordinator.state(), { phase: "active_parallel", current: "next", previous: "new" });
});
