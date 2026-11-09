/** 中文恢复路由服务：管理同模型恢复确认、请求完成校正和分组粘滞迁移。 */
import { isHigherPriority } from "./provider-order.js";
import { providersForGroup } from "./group-routing.js";
export function createRoutingRecovery({ getConfig, getStores, getRecoveryProbeManager, selectProviders, isProviderInAutoRouting, enqueueMigratedResponse }) {
  const confirmedRecoveryModels = new Map();
  // 完整响应结束后重新确认会话归属，避免在途旧请求的最后一次成功回写覆盖恢复后的高优先级供应商。
  function reconcileCompletedStickyProvider({
    stickyRouting,
    routingContext,
    completedProvider,
    responseIds,
    requestModel,
    routeKey,
    groupId,
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

    stickyRouting.migrateToProvider(recoveredHigherPriority.id, {
      model: requestModel,
      shouldReplace: (currentProviderId) => currentProviderId === completedProvider.id,
      onAliasMigrated: (change) => enqueueMigratedResponse(groupId, change),
    });
    return recoveredHigherPriority;
  }

  function recoveryModelKey(providerId, model) {
    const id = String(providerId || "").trim();
    const modelName = String(model || "").trim();
    return id && modelName ? `${id}\u0000${modelName}` : "";
  }

  function markConfirmedRecovery(provider, model) {
    const key = recoveryModelKey(provider?.id, model);
    if (key) confirmedRecoveryModels.set(key, Date.now());
  }

  function clearConfirmedRecovery(providerOrId, model = "") {
    getRecoveryProbeManager()?.resetEvidence(providerOrId, model);
    const providerId = typeof providerOrId === "object" ? providerOrId?.id : providerOrId;
    const id = String(providerId || "").trim();
    if (!id) return;
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
      migrated += store.migrateToProvider(provider.id, {
        model: recoveredModel,
        onAliasMigrated: (change) => enqueueMigratedResponse(groupId, change),
        shouldReplace: (currentProviderId) => {
          const current = providers.find((item) => item.id === currentProviderId);
          return Boolean(current) && isHigherPriority(recovered, current);
        },
      });
    }
    return migrated;
  }

  return { reconcileCompletedStickyProvider, markConfirmedRecovery, clearConfirmedRecovery, isRecoveryConfirmed, migrateStickyToRecoveredProvider };
}
