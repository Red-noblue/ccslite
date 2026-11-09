/**
 * 实时供应商统计测试：覆盖多供应商并发、长请求、幂等结束和五秒窗口过期推送。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createProviderActivity } from "../../lib/provider-activity.js";

test("同一供应商的跨组活动互不污染", () => {
  const activity = createProviderActivity();
  const endDefault = activity.start({ id: "same", name: "共享供应商" });
  assert.deepEqual(activity.snapshot("clone").providers, []);
  const endClone = activity.start({ id: "same", name: "共享供应商" }, "health_check", "clone");
  assert.equal(activity.snapshot("default").providers[0].activeRequests, 1);
  assert.equal(activity.snapshot("clone").providers[0].activeByKind.health_check, 1);
  endDefault();
  assert.equal(activity.snapshot("clone").providers[0].activeRequests, 1);
  endClone();
});

test("多个供应商并发和长请求保持活跃，同供应商按请求计数", () => {
  let clock = 0;
  const activity = createProviderActivity({ now: () => clock });
  const endA1 = activity.start({ id: "a", name: "甲" });
  const endA2 = activity.start({ id: "a", name: "甲" }, "health_check");
  const endB = activity.start({ id: "b", name: "乙" });
  clock = 6000;
  assert.deepEqual(activity.snapshot().providers.map((p) => p.activeRequests), [2, 1]);
  endA1();
  endA1();
  assert.equal(activity.snapshot().providers[0].activeRequests, 1);
  assert.equal(activity.snapshot().providers[0].activeByKind.health_check, 1);
  endA2();
  assert.equal(activity.snapshot().providers[0].activeRequests, 0);
  clock += 4999;
  assert.equal(activity.snapshot().providers.length, 2);
  clock += 1;
  assert.deepEqual(activity.snapshot().providers.map((p) => p.providerId), ["b"]);
  endB();
});

test("停止流量后主动推送过期事件，新请求取消旧的过期定时器", async () => {
  let changes = 0;
  const activity = createProviderActivity({ windowMs: 30, onChange: () => { changes += 1; } });
  const end = activity.start({ id: "a", name: "甲" });
  end();
  const endAgain = activity.start({ id: "a", name: "甲" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(activity.snapshot().providers[0].activeRequests, 1);
  assert.equal(changes, 3);
  endAgain();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(activity.snapshot().providers, []);
  assert.equal(changes, 5);
});
