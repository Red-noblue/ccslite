/**
 * 分组配置归一化模块。
 * 分组保存独立端口、供应商引用和路由设置，共享供应商认证配置。
 */

import crypto from "node:crypto";
import { assignGroupColorIndexes } from "./ui-theme.js";
import { copyGroupRouting } from "./group-routing.js";
import { resolveProviderRoutingEnabled } from "./provider-config.js";

const DEFAULT_GROUP_ID = "default";
const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_GROUP_THEME = {
  accentMode: "auto",
  accent: "#0a84ff",
  accentLocked: false,
};
const GROUP_ACCENT_MODES = new Set(["auto", "custom"]);
const UI_PALETTES = new Set(["ocean", "macaron", "oil", "forest", "sunset"]);

export function createDefaultGroup({ providers = [], listenPort = 15720 } = {}) {
  return createGroup({
    id: DEFAULT_GROUP_ID,
    name: "默认分组",
    description: "兼容现有主端口的默认路由分组",
    listener: {
      host: "127.0.0.1",
      port: listenPort,
      enabled: true,
    },
    providerRefs: providers.map((provider, index) => ({
      providerId: provider.id,
      enabled: resolveProviderRoutingEnabled(provider, true),
      sortIndex: provider.sortIndex || index + 1,
    })),
  }, { providers });
}

export function createGroup(payload = {}, defaults = {}) {
  const providerRefs = normalizeProviderRefs(payload.providerRefs, defaults.providers || []);
  return {
    id: normalizeId(payload.id),
    routingVersion: 1,
    name: String(payload.name || "未命名分组").trim() || "未命名分组",
    description: String(payload.description || "").trim(),
    baseGroupId: normalizeNullableId(payload.baseGroupId),
    listener: normalizeListener(payload.listener, defaults.listenPort),
    providerRefs,
    routing: normalizeObject(payload.routing),
    theme: normalizeTheme(payload.theme),
    createdAt: String(payload.createdAt || new Date().toISOString()),
    updatedAt: String(payload.updatedAt || new Date().toISOString()),
  };
}

export function normalizeGroups(groups, { providers = [], listenPort = 15720, listenHost = "127.0.0.1" } = {}) {
  const source = Array.isArray(groups) ? groups : [];
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const result = source.map((group) => {
    // 旧引用的 enabled 表示分组成员资格，实际路由开关与排序一直来自供应商全局配置。
    // 仅迁移一次，之后修改默认分组不会再覆盖其他分组。
    const providerRefs = group.routingVersion === 1 || !Array.isArray(group.providerRefs) ? group.providerRefs
      : group.providerRefs.map((ref) => ({
        ...ref,
        enabled: ref.enabled !== false && resolveProviderRoutingEnabled(byId.get(ref.providerId), true),
        sortIndex: byId.get(ref.providerId)?.sortIndex || ref.sortIndex,
      }));
    return createGroup({ ...group, providerRefs }, { providers, listenPort });
  });

  const ids = new Set();
  for (const group of result) {
    if (ids.has(group.id)) group.id = crypto.randomUUID();
    ids.add(group.id);
  }
  if (!result.some((group) => group.id === DEFAULT_GROUP_ID)) {
    result.unshift(createDefaultGroup({ providers, listenPort }));
  }
  result.find((group) => group.id === DEFAULT_GROUP_ID).listener = {
    host: listenHost, port: listenPort, enabled: true,
  };
  assignGroupColorIndexes(result);
  return result;
}

export function cloneGroup(source, { providers = [], port } = {}) {
  const now = new Date().toISOString();
  const nextPort = normalizePort(port, nextAvailablePort(source?.listener?.port));
  return createGroup({
    ...source,
    id: crypto.randomUUID(),
    name: `${source?.name || "未命名分组"} 副本`,
    description: source?.description || "",
    baseGroupId: null,
    listener: {
      ...(source?.listener || {}),
      port: nextPort,
      enabled: true,
    },
    // 深复制引用数组，确保后续编辑新分组不会修改源分组。
    providerRefs: copyGroupRouting(source, providers),
    createdAt: now,
    updatedAt: now,
  }, { providers });
}

export function sanitizeGroup(group) {
  return {
    id: group.id,
    routingVersion: 1,
    name: group.name,
    description: group.description,
    baseGroupId: group.baseGroupId || null,
    listener: { ...group.listener },
    providerRefs: (group.providerRefs || []).map((item) => ({ ...item })),
    routing: { ...(group.routing || {}) },
    theme: normalizeTheme(group.theme),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

export function normalizeTheme(value) {
  const input = value && typeof value === "object" ? value : {};
  // 兼容旧版 palette 字段：预设已经迁移为全局色系，分组只保留自动或自定义颜色。
  const legacyPalette = String(input.palette || "");
  const accentMode = GROUP_ACCENT_MODES.has(String(input.accentMode || ""))
    ? String(input.accentMode)
    : legacyPalette === "custom" ? "custom" : DEFAULT_GROUP_THEME.accentMode;
  const accent = /^#[0-9a-f]{6}$/i.test(String(input.accent || ""))
    ? String(input.accent).toLowerCase()
    : DEFAULT_GROUP_THEME.accent;
  const hasExplicitLock = typeof input.accentLocked === "boolean";
  return {
    accentMode,
    accent,
    ...(Number.isInteger(input.colorIndex) && input.colorIndex >= 0 ? { colorIndex: input.colorIndex } : {}),
    // 新配置中自定义与锁定是两个独立状态；旧版 custom 默认视为已锁定以保持原行为。
    accentLocked: hasExplicitLock ? input.accentLocked : legacyPalette === "custom",
  };
}

export function normalizeUiPalette(value, fallback = "ocean") {
  const palette = String(value || "");
  return UI_PALETTES.has(palette) ? palette : fallback;
}

function normalizeProviderRefs(value, providers) {
  const fallback = providers.map((provider, index) => ({
    providerId: provider.id,
    enabled: true,
    sortIndex: index + 1,
  }));
  if (!Array.isArray(value)) return fallback;
  const validIds = new Set(providers.map((provider) => provider.id));
  const seen = new Set();
  return value
    .map((item, index) => ({
      providerId: String(item?.providerId || item?.id || "").trim(),
      enabled: item?.enabled !== false,
      sortIndex: positiveInt(item?.sortIndex, index + 1),
    }))
    .filter((item) => {
      if (!item.providerId || !validIds.has(item.providerId) || seen.has(item.providerId)) return false;
      seen.add(item.providerId);
      return true;
    });
}

function normalizeListener(value, fallbackPort) {
  const input = value && typeof value === "object" ? value : {};
  return {
    host: String(input.host || "127.0.0.1").trim() || "127.0.0.1",
    port: normalizePort(input.port, fallbackPort),
    enabled: input.enabled !== false,
  };
}

function normalizePort(value, fallback) {
  const port = Number(value);
  if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) return port;
  return Number.isInteger(Number(fallback)) ? Number(fallback) : null;
}

function nextAvailablePort(port) {
  const base = Number(port);
  return Number.isInteger(base) && base < MAX_PORT ? base + 1 : null;
}

function normalizeId(value) {
  return String(value || crypto.randomUUID()).trim() || crypto.randomUUID();
}

function normalizeNullableId(value) {
  const id = String(value || "").trim();
  return id || null;
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
