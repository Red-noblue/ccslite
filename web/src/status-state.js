/**
 * 管理台状态合并逻辑。
 * 在同一服务实例内防止迟到轮询覆盖 SSE 实时状态；服务重启后立即接受新实例状态。
 */

export function statusRevision(status) {
  const value = Number(status?.statusRevision || 0);
  return Number.isFinite(value) ? value : 0;
}

export function mergeStatus(current, next) {
  if (!current || !next) return next;

  const currentInstanceId = String(current.instanceId || "");
  const nextInstanceId = String(next.instanceId || "");
  if (currentInstanceId && nextInstanceId && currentInstanceId !== nextInstanceId) {
    return next;
  }

  if (statusRevision(next) >= statusRevision(current)) return next;
  return {
    ...next,
    currentProviderId: current.currentProviderId,
    currentProviderName: current.currentProviderName,
    currentProviderUpdatedAt: current.currentProviderUpdatedAt,
    currentProviderSource: current.currentProviderSource,
    providerActivity: current.providerActivity,
    activeRequests: current.activeRequests,
    streamDiagnostics: current.streamDiagnostics,
    groups: current.groups,
    statusRevision: current.statusRevision,
  };
}
