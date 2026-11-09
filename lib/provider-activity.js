/**
 * 供应商实时流量统计：累计并发上游请求，结束后保留五秒，并主动推送过期状态。
 */
export function createProviderActivity({ windowMs = 5000, now = Date.now, onChange = () => {} } = {}) {
  const entries = new Map();

  function start(provider, kind = "business", groupId = "default") {
    const key = JSON.stringify([groupId, provider.id]);
    let entry = entries.get(key);
    if (!entry) {
      entry = { groupId, providerId: provider.id, activeRequests: 0, activeByKind: {}, timer: null };
      entries.set(key, entry);
    }
    clearTimeout(entry.timer);
    entry.providerName = provider.name;
    entry.activeRequests += 1;
    entry.activeByKind[kind] = (entry.activeByKind[kind] || 0) + 1;
    entry.lastActivityAt = now();
    onChange();

    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      entry.activeRequests -= 1;
      entry.activeByKind[kind] -= 1;
      entry.lastActivityAt = now();
      if (entry.activeRequests === 0) {
        entry.timer = setTimeout(() => {
          entries.delete(key);
          onChange();
        }, windowMs);
        entry.timer.unref();
      }
      onChange();
    };
  }

  function snapshot(groupId = null) {
    return {
      windowMs,
      providers: [...entries.values()]
        .filter((entry) => groupId === null || entry.groupId === groupId)
        .filter((entry) => entry.activeRequests > 0 || now() - entry.lastActivityAt < windowMs)
        .map(({ timer, ...entry }) => ({ ...entry, activeByKind: { ...entry.activeByKind } })),
    };
  }

  return { start, snapshot };
}
