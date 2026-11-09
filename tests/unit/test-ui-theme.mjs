/**
 * 色系行为测试：验证分组多色、删除后颜色稳定及自定义与锁定的独立作用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGroups } from "../../lib/group-config.js";
import { applyGlobalPalette, paletteForGroup } from "../../lib/ui-theme.js";

test("同一色系下首组粉色、次组蓝色，各自派生背景与阴影", () => {
  const groups = normalizeGroups([{ id: "default" }, { id: "second" }]);
  const pink = paletteForGroup(groups[0], 0, "macaron");
  const blue = paletteForGroup(groups[1], 1, "macaron");
  assert.equal(pink.accent, "#dc93b0");
  assert.equal(blue.accent, "#8cb9dc");
  for (const field of ["primary", "hover", "soft", "start", "end", "shadow"]) {
    assert.notEqual(pink[field], blue[field]);
  }
  const remaining = normalizeGroups([groups[1]]);
  assert.equal(paletteForGroup(remaining[1], 1, "macaron").accent, blue.accent);
});

test("未锁定自定义可手动改色，换色系才覆盖，保留自定义资格", () => {
  const groups = normalizeGroups([{ id: "default", theme: { accentMode: "custom", accent: "#123456", accentLocked: false } }]);
  assert.equal(paletteForGroup(groups[0], 0, "macaron").accent, "#123456");
  applyGlobalPalette(groups, "oil");
  assert.equal(groups[0].theme.accentMode, "custom");
  assert.equal(groups[0].theme.accentLocked, false);
  assert.equal(paletteForGroup(groups[0], 0, "oil").accent, "#a65f43");
  groups[0].theme.accent = "#654321";
  assert.equal(paletteForGroup(groups[0], 0, "oil").accent, "#654321");
});

test("锁定分组在全局换色系后保持颜色和所有派生色", () => {
  const groups = normalizeGroups([{ id: "default", theme: { accentMode: "custom", accent: "#123456", accentLocked: true } }]);
  const before = paletteForGroup(groups[0], 0, "macaron");
  applyGlobalPalette(groups, "oil");
  const after = paletteForGroup(groups[0], 0, "oil");
  for (const field of ["accent", "hover", "start", "end", "shadow"]) assert.equal(before[field], after[field]);
});
