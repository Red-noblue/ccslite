/** 中文恢复路由服务：管理同模型恢复确认、请求完成校正和分组粘滞迁移。 */
import { isHigherPriority } from "./provider-order.js";
import { providersForGroup } from "./group-routing.js";
import crypto from "node:crypto";
export function createRoutingRecovery({ getConfig, getStores, getRecoveryProbeManager, selectProviders, isProviderInAutoRouting, enqueueMigratedResponse, onRecoveryEvent = () => null }) {
  const confirmedRecoveryModels = new Map();
  function observe(kind, provider, model, groupId, details = {}) {
    const evidence = confirmedRecoveryModels.get(recoveryModelKey(provider?.id, model));
    if (!evidence) return;
    try {
      const eventId = onRecoveryEvent({ kind, groupId, providerId: provider.id, providerName: provider.name || provider.id, model,
        confirmationId: evidence.confirmationId, source: evidence.source, successCount: evidence.successCount, requestId: evidence.requestId, ...details });
      const group = evidence.groups.get(groupId) || {};
      if (kind === "confirmed") group.confirmationEventId = eventId;
      if (kind === "bindings_migrated") group.migrationEventId = eventId;
      evidence.groups.set(groupId, group);
    } catch { /* 观察失败不能改变既有路由结果。 */ }
  }
  // 完整响应结束后重新确认会话归属，避免在途旧请求的最后一次成功回写覆盖恢复后的高优先级供应商。
  function reconcileCompletedStickyProvider({
    stickyRouting,
    routingContext,
    completedProvider,
    responseIds,
    requestModel,
    routeKey,
    groupId,
    requestId,
  }) {
    stickyRouting.rememberSuccess(routingContext?.key, completedProvider.id, responseIds, requestModel);
    if (routeKey !== "cct" || !routingContext?.key || !requestModel) return completedProvider;

    const candidates = selectProviders(requestModel, routeKey, routingContext, groupId);
    const completed = candidates.find((provider) => provider.id === completedProvider.id) || completedProvider;
    const recoveredHigherPriority = candidates.find((provider) =>
      provider.id !== completedProvider.id &&
      isHigherPriority(provider, completed) &&
      isRecoveryConfirmed(provider, requestModel),
    );
    if (!recoveredHigherPriority) return completedProvider;

    const migrated = stickyRouting.migrateToProvider(recoveredHigherPriority.id, {
      model: requestModel,
      shouldReplace: (currentProviderId) => currentProviderId === completedProvider.id,
      onAliasMigrated: (change) => enqueueMigratedResponse(groupId, change),
    });
    if (migrated) observe("bindings_migrated", recoveredHigherPriority, requestModel, groupId, { migratedBindings: migrated, reason: "request_completed", requestId });
    return recoveredHigherPriority;
  }

  function recoveryModelKey(providerId, model) {
    const id = String(providerId || "").trim();
    const modelName = String(model || "").trim();
    return id && modelName ? `${id}\u0000${modelName}` : "";
  }

  function markConfirmedRecovery(provider, model, { source = "manual", successCount = 1, requestId = "" } = {}) {
    const key = recoveryModelKey(provider?.id, model);
    if (!key) return;
    confirmedRecoveryModels.set(key, { confirmationId: crypto.randomUUID(), confirmedAt: new Date().toISOString(), source, successCount, requestId, groups: new Map() });
    for (const group of getConfig().groups || []) {
      const member = providersForGroup(getConfig(), group.id).find((item) => item.id === provider.id);
      if (member && isProviderInAutoRouting(member)) observe("confirmed", provider, model, group.id, { reason: "recovery_confirmed" });
    }
  }

  function clearConfirmedRecovery(providerOrId, model = "") {
    getRecoveryProbeManager()?.resetEvidence(providerOrId, model);
    const providerId = typeof providerOrId === "object" ? providerOrId?.id : providerOrId;
    const id = String(providerId || "").trim();
    if (!id) return;
    for (const [key, evidence] of confirmedRecoveryModels) {
      if (!key.startsWith(`${id}\u0000`) || model && key !== recoveryModelKey(id, model)) continue;
      const provider = getConfig().providers.find((item) => item.id === id) || { id };
      for (const groupId of evidence.groups.keys()) observe("invalidated", provider, key.slice(id.length + 1), groupId, { reason: "failure_or_configuration" });
    }
    if (model) {
      confirmedRecoveryModels.delete(recoveryModelKey(id, model));
      return;
    }
    const prefix = `${id}\u0000`;
    for (const key of confirmedRecoveryModels.keys()) {
      if (key.startsWith(prefix)) confirmedRecoveryModels.delete(key);
    }
  }

  function isRecoveryConfirmed(provider, model) {
    return Boolean(recoveryModelKey(provider?.id, model) &&
      confirmedRecoveryModels.has(recoveryModelKey(provider?.id, model)));
  }

  function getRecoveryEvidence(provider, model, groupId) {
    const evidence = confirmedRecoveryModels.get(recoveryModelKey(provider?.id, model));
    const group = evidence?.groups.get(groupId);
    return group?.confirmationEventId ? { ...group, providerId: provider.id, confirmedAt: evidence.confirmedAt } : null;
  }

  function migrateStickyToRecoveredProvider(provider, model) {
    const recoveredModel = String(model || "").trim();
    if (!provider?.id || !recoveredModel || !provider.baseUrl) {
      return 0;
    }
    let migrated = 0;
    for (const [groupId, store] of getStores()) {
      const providers = providersForGroup(getConfig(), groupId);
      const recovered = providers.find((item) => item.id === provider.id);
      if (!recovered || !isProviderInAutoRouting(recovered)) continue;
      const count = store.migrateToProvider(provider.id, {
        model: recoveredModel,
        onAliasMigrated: (change) => enqueueMigratedResponse(groupId, change),
        shouldReplace: (currentProviderId) => {
          const current = providers.find((item) => item.id === currentProviderId);
          return Boolean(current) && isHigherPriority(recovered, current);
        },
      });
      migrated += count;
      if (count) observe("bindings_migrated", provider, recoveredModel, groupId, { migratedBindings: count, reason: "recovery_confirmed" });
    }
    return migrated;
  }

  return { reconcileCompletedStickyProvider, markConfirmedRecovery, clearConfirmedRecovery, isRecoveryConfirmed, migrateStickyToRecoveredProvider, getRecoveryEvidence };
}
