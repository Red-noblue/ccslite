/**
 * 前端分组供应商视图：以分组引用为准，并复用后端的优先级和名称排序规则。
 */

import { compareProviders } from "../../lib/provider-order.js";

export function providersForGroupView(sharedProviders, group) {
  const providers = Array.isArray(sharedProviders) ? sharedProviders : [];
  if (!group || !Array.isArray(group.providerRefs)) {
    return providers.slice().sort(compareProviders);
  }

  const refs = new Map(group.providerRefs.map((ref) => [ref.providerId, ref]));
  return providers.map((provider, index) => {
    const ref = refs.get(provider.id);
    const routingEnabled = Boolean(ref && ref.enabled !== false);
    return {
      ...provider,
      routingEnabled,
      enabled: routingEnabled,
      inFailoverQueue: routingEnabled,
      sortIndex: ref?.sortIndex || providers.length + index + 1,
    };
  }).sort(compareProviders);
}
