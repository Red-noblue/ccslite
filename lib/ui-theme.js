/**
 * 分组色系与派生颜色：前后端共享颜色分配规则，支持自定义、锁定和全局色系切换。
 */
export const UI_PALETTE_PRESETS = [
  { value: "ocean", label: "海洋", groupAccents: ["#0a84ff", "#36a3d9", "#5964d9", "#168f8b", "#e08b3e"] },
  { value: "macaron", label: "马卡龙", groupAccents: ["#dc93b0", "#8cb9dc", "#97c7b3", "#b3a1cf", "#e3c17d", "#e1aa91"] },
  { value: "oil", label: "油画", groupAccents: ["#a65f43", "#38556b", "#55735f", "#b88a43", "#7d5368", "#83724b"] },
  { value: "forest", label: "森林", groupAccents: ["#2f8f72", "#5b8f45", "#3d789d", "#8f9e45", "#76609b"] },
  { value: "sunset", label: "落日", groupAccents: ["#e47745", "#d65d73", "#aa5d9f", "#4f82b8", "#d39a3f"] },
];

export function hexToRgba(hex, alpha) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function mix(hex, target, ratio) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `#${[16, 8, 0].map((shift) => Math.round(((value >> shift) & 255) * (1 - ratio) + target * ratio).toString(16).padStart(2, "0")).join("")}`;
}

export function getUiPalette(value) {
  return UI_PALETTE_PRESETS.find((item) => item.value === value) || UI_PALETTE_PRESETS[0];
}

export function automaticGroupAccent(group, index = 0, palette = "ocean") {
  const colors = getUiPalette(palette).groupAccents;
  const slot = Number.isInteger(group?.theme?.colorIndex) ? group.theme.colorIndex : index;
  return colors[((slot % colors.length) + colors.length) % colors.length];
}

export function paletteForGroup(group, index = 0, palette = "ocean") {
  const theme = group?.theme || {};
  const preset = getUiPalette(palette);
  const custom = theme.accentMode === "custom" || theme.accentLocked === true || theme.palette === "custom";
  const accent = custom && /^#[0-9a-f]{6}$/i.test(theme.accent || "")
    ? theme.accent : automaticGroupAccent(group, index, palette);
  return {
    ...preset,
    accent,
    primary: accent,
    hover: mix(accent, 0, 0.18),
    soft: hexToRgba(accent, 0.12),
    shadow: hexToRgba(accent, 0.24),
    start: mix(accent, 255, 0.95),
    end: mix(accent, 255, 0.90),
  };
}

export function assignGroupColorIndexes(groups) {
  const used = new Set();
  for (const group of groups) {
    let slot = group.theme.colorIndex;
    if (!Number.isInteger(slot) || used.has(slot)) {
      slot = 0;
      while (used.has(slot)) slot += 1;
    }
    group.theme.colorIndex = slot;
    used.add(slot);
  }
}

export function applyGlobalPalette(groups, palette) {
  for (const [index, group] of groups.entries()) {
    if (!group.theme.accentLocked) {
      group.theme.accent = automaticGroupAccent(group, index, palette);
    }
  }
}
