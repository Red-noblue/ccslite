/**
 * 分组配置模块测试。
 * 验证旧配置默认分组、供应商引用归一化和完整复制行为。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  cloneGroup,
  createDefaultGroup,
  normalizeGroups,
} from "../../lib/group-config.js";
import { connectivityTargets, providersForGroup } from "../../lib/group-routing.js";

const providers = [
  { id: "cheap", name: "低价供应商" },
  { id: "reliable", name: "高可靠供应商" },
];

test("默认分组的旧端口必须纠正为当前实际主服务地址", () => {
  const groups = normalizeGroups([{ id: "default", listener: { port: 15723, host: "0.0.0.0", enabled: false } }], {
    listenPort: 15720, listenHost: "127.0.0.1",
  });
  assert.deepEqual(groups[0].listener, { port: 15720, host: "127.0.0.1", enabled: true });
});

test("旧配置没有分组时会生成包含全部供应商的默认分组", () => {
  const groups = normalizeGroups(undefined, { providers, listenPort: 15720 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "default");
  assert.deepEqual(groups[0].providerRefs.map((item) => item.providerId), ["cheap", "reliable"]);
  assert.equal(groups[0].listener.port, 15720);
});

test("复制分组会复制全部供应商引用并生成独立身份和端口", () => {
  const source = createDefaultGroup({ providers, listenPort: 15720 });
  const copy = cloneGroup(source, { providers, port: 15721 });
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.name, "默认分组 副本");
  assert.equal(copy.listener.port, 15721);
  assert.equal(copy.listener.enabled, true);
  assert.deepEqual(copy.providerRefs, source.providerRefs);
  assert.notEqual(copy.providerRefs, source.providerRefs);
  assert.equal(copy.baseGroupId, null);
});

test("无效供应商引用会被过滤，避免分组引用已删除供应商", () => {
  const groups = normalizeGroups([{
    id: "design",
    name: "项目设计",
    providerRefs: [
      { providerId: "reliable", enabled: true, sortIndex: 2 },
      { providerId: "missing", enabled: true, sortIndex: 1 },
      { providerId: "reliable", enabled: false, sortIndex: 3 },
    ],
  }], { providers, listenPort: 15720 });
  const design = groups.find((group) => group.id === "design");
  assert.deepEqual(design.providerRefs, [{ providerId: "reliable", enabled: true, sortIndex: 2 }]);
  assert.ok(groups.some((group) => group.id === "default"));
});

test("旧分组按实际开关和排序迁移一次，之后独立配置不会被默认分组覆盖", () => {
  const providers = [
    { id: "a", routingEnabled: false, sortIndex: 2 },
    { id: "b", routingEnabled: true, sortIndex: 1 },
  ];
  const groups = normalizeGroups([{ id: "quality", providerRefs: [
    { providerId: "a", enabled: true, sortIndex: 1 },
    { providerId: "b", enabled: true, sortIndex: 2 },
  ] }], { providers });
  const quality = groups.find((group) => group.id === "quality");
  assert.equal(quality.routingVersion, 1);
  assert.deepEqual(quality.providerRefs, [
    { providerId: "a", enabled: false, sortIndex: 2 },
    { providerId: "b", enabled: true, sortIndex: 1 },
  ]);
  quality.providerRefs[0].enabled = true;
  quality.providerRefs[0].sortIndex = 1;
  providers[1].routingEnabled = false;
  const restored = normalizeGroups(groups, { providers }).find((group) => group.id === "quality");
  assert.deepEqual(restored.providerRefs, quality.providerRefs);
});

test("全局周期检测按供应商身份去重并覆盖非默认分组独有的供应商", () => {
  const config = {
    providers: [
      { id: "a", baseUrl: "http://same-upstream", routingEnabled: true },
      { id: "b", baseUrl: "http://same-upstream", routingEnabled: false },
      { id: "c", baseUrl: "http://other-upstream", routingEnabled: false },
    ],
    groups: [
      { id: "default" },
      { id: "copy", listener: { enabled: true }, providerRefs: [{ providerId: "a", enabled: true }] },
      { id: "quality", listener: { enabled: true }, providerRefs: [{ providerId: "a", enabled: true }, { providerId: "b", enabled: true }] },
      { id: "stopped", listener: { enabled: false }, providerRefs: [{ providerId: "c", enabled: true }] },
    ],
  };
  const targets = connectivityTargets(config);
  assert.deepEqual(targets.map((item) => item.provider.id), ["a", "b"]);
  assert.deepEqual(targets[0].groupIds, ["default", "copy", "quality"]);
  assert.equal(targets[0].groupId, "default");
  assert.equal(targets[1].groupId, "quality");
  assert.deepEqual(connectivityTargets(config, "copy").map((item) => item.provider.id), ["a"]);
  assert.deepEqual(connectivityTargets(config, "stopped").map((item) => item.provider.id), ["c"]);
});

test("默认分组的引用开关和排序会实际约束路由与周期检测", () => {
  const config = {
    providers: [
      { id: "cheap", baseUrl: "http://cheap", routingEnabled: true, sortIndex: 9 },
      { id: "disabled-in-group", baseUrl: "http://disabled", routingEnabled: true, sortIndex: 1 },
    ],
    groups: [{ id: "default", providerRefs: [
      { providerId: "cheap", enabled: true, sortIndex: 1 },
      { providerId: "disabled-in-group", enabled: false, sortIndex: 2 },
    ] }],
  };
  const view = providersForGroup(config, "default");
  assert.deepEqual(view.map((provider) => ({ id: provider.id, enabled: provider.enabled, sortIndex: provider.sortIndex })), [
    { id: "cheap", enabled: true, sortIndex: 1 },
    { id: "disabled-in-group", enabled: false, sortIndex: 2 },
  ]);
  assert.deepEqual(connectivityTargets(config).map((item) => item.provider.id), ["cheap"]);
});
