/**
 * 前端供应商视图测试：验证分组开关和排序与后端规则一致。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { compareProviders, isHigherPriority } from "../../lib/provider-order.js";
import { providersForGroupView } from "../../web/src/provider-view.js";

test("同优先级按后端中文名称规则排序，猫猫 1 排在 aimz-test1 前", () => {
  const providers = [
    { id: "aimz", name: "aimz-test1", sortIndex: 1 },
    { id: "cat", name: "猫猫 1", sortIndex: 1 },
  ];

  assert.deepEqual(providers.slice().sort(compareProviders).map((provider) => provider.id), ["cat", "aimz"]);
  assert.equal(isHigherPriority(providers[1], providers[0]), true);
  assert.equal(isHigherPriority(providers[0], providers[1]), false);
});

test("默认分组视图使用 providerRefs 覆盖全局路由开关和优先级", () => {
  const sharedProviders = [
    { id: "cx1", name: "cx1", routingEnabled: true, sortIndex: 3 },
    { id: "aimz", name: "aimz-test1", routingEnabled: true, sortIndex: 1 },
    { id: "cat", name: "猫猫 1", routingEnabled: true, sortIndex: 1 },
  ];
  const group = {
    id: "default",
    providerRefs: [
      { providerId: "aimz", enabled: false, sortIndex: 1 },
      { providerId: "cx1", enabled: true, sortIndex: 3 },
      { providerId: "cat", enabled: true, sortIndex: 1 },
    ],
  };

  const view = providersForGroupView(sharedProviders, group);
  assert.deepEqual(view.map(({ id, routingEnabled, sortIndex }) => ({ id, routingEnabled, sortIndex })), [
    { id: "cat", routingEnabled: true, sortIndex: 1 },
    { id: "aimz", routingEnabled: false, sortIndex: 1 },
    { id: "cx1", routingEnabled: true, sortIndex: 3 },
  ]);
  assert.equal(view.find((provider) => provider.id === "aimz").enabled, false);
  assert.equal(view.find((provider) => provider.id === "aimz").inFailoverQueue, false);
});
