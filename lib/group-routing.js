/**
 * 分组供应商视图：共享认证配置，分别保存各组参与路由的开关、优先级和手动选择。
 */
import { resolveProviderRoutingEnabled } from "./provider-config.js";
import { compareProviders } from "./provider-order.js";

export function providersForGroup(config, groupId = "default") {
  const group = config.groups.find((item) => item.id === groupId);
  // 默认分组也使用自己的引用；全局供应商字段只保留认证和兼容配置，避免网页显示与实际路由不一致。
  // 没有分组对象时仅用于极旧配置的只读兼容，正常配置会在 normalizeGroups 中补齐默认分组。
  if (groupId === "default" && (!group || !Array.isArray(group.providerRefs))) {
    return config.providers.slice().sort(compareProviders);
  }
  const refs = new Map((group?.providerRefs || []).map((ref) => [ref.providerId, ref]));
  return config.providers.map((provider, index) => {
    const ref = refs.get(provider.id);
    const enabled = Boolean(ref && ref.enabled !== false);
    return { ...provider, routingEnabled: enabled, enabled, inFailoverQueue: enabled, sortIndex: ref?.sortIndex || index + 1 };
  }).sort(compareProviders);
}

export function groupProxy(config, groupId = "default") {
  const routing = config.groups.find((group) => group.id === groupId)?.routing || {};
  return groupId === "default" ? config.proxy
    : { ...config.proxy, ...routing, currentProviderId: routing.currentProviderId || null, circuit: config.proxy.circuit };
}

export function copyGroupRouting(source, providers) {
  if (Array.isArray(source?.providerRefs)) return source.providerRefs.map((ref) => ({ ...ref }));
  return providers.map((provider, index) => ({
    providerId: provider.id,
    enabled: resolveProviderRoutingEnabled(provider, true),
    sortIndex: provider.sortIndex || index + 1,
  }));
}

// 周期检测覆盖已启用分组的供应商并集，按供应商身份去重，避免复制分组增加检测费用。
export function connectivityTargets(config, groupId) {
  const groups = config.groups.filter((group) => groupId ? group.id === groupId
    : group.id === "default" || group.listener?.enabled !== false);
  const targets = new Map();
  for (const group of groups) {
    for (const provider of providersForGroup(config, group.id)) {
      if (!provider.baseUrl || !resolveProviderRoutingEnabled(provider, true)) continue;
      if (!targets.has(provider.id)) targets.set(provider.id, { provider, groupId: group.id, groupIds: [] });
      targets.get(provider.id).groupIds.push(group.id);
    }
  }
  return [...targets.values()];
}
