/**
 * 管理台实时状态合并测试。
 * 确保同实例的迟到轮询不会覆盖 SSE，而服务重启后的新实例状态可以立即接管。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mergeStatus } from "../../web/src/status-state.js";

test("同一实例中拒绝迟到轮询覆盖更晚的路由状态", () => {
  const merged = mergeStatus(
    {
      instanceId: "instance-a",
      statusRevision: 8,
      currentProviderId: "cat",
      currentProviderName: "猫猫test1",
      currentProviderUpdatedAt: "2026-09-03T10:00:08.000Z",
      currentProviderSource: "proxy_attempt",
      providerActivity: { windowMs: 5000, providers: [{ providerId: "cat", activeRequests: 2 }] },
      groups: [{ id: "default", statistics: { totalRequests: 8 } }],
    },
    {
      instanceId: "instance-a",
      statusRevision: 7,
      currentProviderId: "aimz",
      currentProviderName: "aimz-test1",
      providerActivity: { windowMs: 5000, providers: [] },
      groups: [{ id: "default", statistics: { totalRequests: 7 } }],
    },
  );

  assert.equal(merged.currentProviderId, "cat");
  assert.equal(merged.currentProviderName, "猫猫test1");
  assert.equal(merged.statusRevision, 8);
  assert.equal(merged.providerActivity.providers[0].activeRequests, 2);
  assert.equal(merged.groups[0].statistics.totalRequests, 8);
});

test("服务重启后接受新实例的低版本状态", () => {
  const next = {
    instanceId: "instance-b",
    statusRevision: 1,
    currentProviderId: "cat",
    currentProviderName: "猫猫test1",
    currentProviderUpdatedAt: "2026-09-03T10:01:00.000Z",
    currentProviderSource: "proxy_attempt",
  };
  const merged = mergeStatus({
    instanceId: "instance-a",
    statusRevision: 999,
    currentProviderId: "aimz",
    currentProviderName: "aimz-test1",
  }, next);

  assert.deepEqual(merged, next);
});
