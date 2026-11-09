/**
 * 自动恢复 CCOK 探测调度测试。
 * 验证单供应商去重、固定间隔重试和连续两次成功才恢复路由。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryProbeManager } from "../../lib/recovery-probes.js";

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("恢复探测按 5 秒间隔运行，连续两次成功后恢复", async () => {
  const timers = [];
  const testedModels = [];
  let recovered = 0;
  const provider = { id: "p1", name: "供应商 1" };
  const manager = createRecoveryProbeManager({
    intervalMs: 5_000,
    requiredSuccesses: 2,
    getModel: async () => "gpt-5.6-terra",
    testProvider: async (_provider, model) => {
      testedModels.push(model);
      return { ok: true, status: 200, message: "CCOK" };
    },
    onRecovered: async () => { recovered += 1; },
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  assert.equal(manager.schedule(provider, "business_failure"), true);
  assert.equal(manager.schedule(provider, "duplicate"), false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5_000);

  timers.shift().callback();
  await flush();
  assert.equal(recovered, 0);
  assert.equal(manager.status()[0].successStreak, 1);
  assert.equal(timers.length, 1);

  timers.shift().callback();
  await flush();
  assert.equal(recovered, 1);
  assert.deepEqual(testedModels, ["gpt-5.6-terra", "gpt-5.6-terra"]);
  assert.equal(manager.status()[0].successStreak, 0);
  assert.equal(manager.status()[0].recoveryConfirmed, true);
  assert.equal(manager.status()[0].confirmedModels[0].model, "gpt-5.6-terra");
  assert.equal(manager.status()[0].lastConfirmedSource, "probe");
  assert.equal(timers.length, 0);
});

test("恢复探测失败后清零连续成功次数并继续调度", async () => {
  const timers = [];
  const results = [{ ok: true }, { ok: false, status: 503 }, { ok: true }, { ok: true }];
  let recovered = 0;
  const manager = createRecoveryProbeManager({
    intervalMs: 5_000,
    requiredSuccesses: 2,
    getModel: async () => "gpt-5.6-luna",
    testProvider: async () => results.shift() || { ok: true, status: 200 },
    onRecovered: async () => { recovered += 1; },
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });

  manager.schedule({ id: "p2", name: "供应商 2" });
  for (let index = 0; index < 4; index += 1) {
    timers.shift().callback();
    await flush();
  }
  assert.equal(recovered, 1);
  assert.equal(timers.length, 0);
});

test("恢复确认要求连续成功使用同一个模型", async () => {
  const timers = [];
  const models = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-luna"];
  let recovered = 0;
  const manager = createRecoveryProbeManager({
    intervalMs: 5_000,
    requiredSuccesses: 2,
    getModel: async () => models.shift(),
    testProvider: async () => ({ ok: true, status: 200, message: "CCOK" }),
    onRecovered: async () => { recovered += 1; },
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });

  manager.schedule({ id: "p-model", name: "模型切换供应商" });
  for (let index = 0; index < 3; index += 1) {
    timers.shift().callback();
    await flush();
  }
  assert.equal(recovered, 1);
});

test("真实请求成功时可以取消尚未开始的探测", () => {
  const timers = [];
  const manager = createRecoveryProbeManager({
    intervalMs: 5_000,
    getModel: async () => "gpt-5.6-luna",
    testProvider: async () => ({ ok: true }),
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const provider = { id: "p3", name: "供应商 3" };
  assert.equal(manager.schedule(provider), true);
  assert.equal(manager.cancel(provider), true);
  assert.equal(timers.length, 0);
  assert.equal(manager.status()[0].scheduledAt, null);
});

test("取消正在执行的探测后不会再次排队", async () => {
  const timers = [];
  let resolveProbe;
  const probeFinished = new Promise((resolve) => { resolveProbe = resolve; });
  const manager = createRecoveryProbeManager({
    intervalMs: 5_000,
    getModel: async () => "gpt-5.6-luna",
    testProvider: async () => {
      await probeFinished;
      return { ok: false, status: 503 };
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });
  const provider = { id: "p4", name: "供应商 4" };
  manager.schedule(provider);
  timers.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  manager.cancel(provider);
  resolveProbe();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 0);
});

function recoveryFixture(options = {}) {
  const timers = [];
  const recovered = [];
  const provider = { id: "shared", name: "共享供应商" };
  const manager = createRecoveryProbeManager({
    getModel: () => "model-a",
    testProvider: async () => ({ ok: true, status: 200 }),
    onRecovered: async (_provider, result) => { recovered.push(result); },
    setTimer: (callback) => {
      const timer = { callback };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    ...options,
  });
  const probe = async () => {
    assert.ok(timers.length, "应保留未完成恢复确认的后台探测");
    timers.shift().callback();
    await flush();
  };
  return { manager, provider, timers, recovered, probe };
}

test("两次真实业务成功确认恢复，一次成功不会取消必要的探测", async () => {
  const { manager, provider, timers, recovered } = recoveryFixture();
  manager.schedule(provider, "business_failure", "model-a");
  await manager.recordSuccess(provider, "model-a", { source: "business", status: 200 });
  assert.equal(recovered.length, 0);
  assert.equal(timers.length, 1);
  await manager.recordSuccess(provider, "model-a", { source: "business", status: 200 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].model, "model-a");
  assert.equal(recovered[0].source, "business");
  assert.equal(timers.length, 0);
  await manager.recordSuccess(provider, "model-a");
  assert.equal(recovered.length, 1, "已确认的模型不应在每次成功时重复触发回迁");
});

for (const businessFirst of [true, false]) {
  test(`${businessFirst ? "业务后探测" : "探测后业务"}共同达到两次成功即可恢复`, async () => {
    const { manager, provider, timers, recovered, probe } = recoveryFixture();
    manager.schedule(provider, "business_failure", "model-a");
    if (businessFirst) await manager.recordSuccess(provider, "model-a", { source: "business" });
    await probe();
    if (!businessFirst) {
      assert.equal(recovered.length, 0);
      await manager.recordSuccess(provider, "model-a", { source: "business" });
    }
    assert.equal(recovered.length, 1);
    assert.equal(timers.length, 0);
  });
}

test("按模型独立累计，相关失败重置证据，其他模型成功不能取消目标模型探测", async () => {
  const { manager, provider, timers, recovered } = recoveryFixture();
  manager.schedule(provider, "business_failure", "model-a");
  await manager.recordSuccess(provider, "model-a");
  await manager.recordSuccess(provider, "model-b");
  manager.resetEvidence(provider, "model-a");
  await manager.recordSuccess(provider, "model-b");
  assert.deepEqual(recovered.map((result) => result.model), ["model-b"]);
  assert.equal(timers.length, 1);
  await manager.recordSuccess(provider, "model-a");
  assert.equal(recovered.length, 1, "失败前的成功不能带入下一轮确认");
  await manager.recordSuccess(provider, "model-a");
  assert.deepEqual(recovered.map((result) => result.model), ["model-b", "model-a"]);
  assert.equal(timers.length, 0);
});

test("后台探测失败同样重置业务证据，下一次业务成功仍需继续确认", async () => {
  const { manager, provider, recovered, probe } = recoveryFixture({ testProvider: async () => ({ ok: false, status: 503 }) });
  manager.schedule(provider, "business_failure", "model-a");
  await manager.recordSuccess(provider, "model-a");
  await probe();
  await manager.recordSuccess(provider, "model-a");
  assert.equal(recovered.length, 0);
  await manager.recordSuccess(provider, "model-a");
  assert.equal(recovered.length, 1);
});

test("业务确认恢复后忽略在途探测结果，取消配置对应的证据也不能复用", async () => {
  let finishProbe;
  const pending = new Promise((resolve) => { finishProbe = resolve; });
  const { manager, provider, timers, recovered, probe } = recoveryFixture({ testProvider: () => pending });
  manager.schedule(provider, "business_failure", "model-a");
  await probe();
  await manager.recordSuccess(provider, "model-a");
  await manager.recordSuccess(provider, "model-a");
  finishProbe({ ok: true });
  await flush();
  assert.equal(recovered.length, 1);
  assert.equal(timers.length, 0);
  manager.cancel(provider);
  await manager.recordSuccess(provider, "model-a");
  assert.equal(recovered.length, 1);
  await manager.recordSuccess(provider, "model-a");
  assert.equal(recovered.length, 2);
  manager.stop();
});

test("同供应商多个故障模型共用一个探测队列，恢复一个后继续确认另一个", async () => {
  const tested = [];
  const { manager, provider, timers, recovered, probe } = recoveryFixture({
    testProvider: async (_provider, model) => { tested.push(model); return { ok: true }; },
  });
  manager.schedule(provider, "business_failure", "model-a");
  manager.schedule({ ...provider }, "business_failure", "model-b");
  assert.equal(timers.length, 1);
  await manager.recordSuccess(provider, "model-a");
  await manager.recordSuccess(provider, "model-a");
  assert.equal(timers.length, 1, "模型 A 恢复不能丢弃模型 B 的探测");
  await probe(); await probe();
  assert.deepEqual(tested, ["model-b", "model-b"]);
  assert.deepEqual(recovered.map((result) => result.model), ["model-a", "model-b"]);
  assert.equal(timers.length, 0);
});

test("业务确认后再次失败时，在途旧探测退出后仍继续新一轮确认", async () => {
  let finishProbe;
  const pending = new Promise((resolve) => { finishProbe = resolve; });
  let count = 0;
  const { manager, provider, timers, recovered, probe } = recoveryFixture({
    testProvider: () => ++count === 1 ? pending : Promise.resolve({ ok: true }),
  });
  manager.schedule(provider, "business_failure", "model-a");
  await probe();
  await manager.recordSuccess(provider, "model-a");
  await manager.recordSuccess(provider, "model-a");
  manager.resetEvidence(provider, "model-a");
  manager.schedule(provider, "business_failure", "model-a");
  finishProbe({ ok: true });
  await flush();
  assert.equal(recovered.length, 1, "已取消的在途结果不能确认新的恢复轮次");
  assert.equal(timers.length, 1);
  await probe();
  assert.equal(recovered.length, 1);
  await probe();
  assert.equal(recovered.length, 2);
  assert.equal(timers.length, 0);
});
