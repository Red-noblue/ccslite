/** 请求开始时的路由证据快照：只保存安全元数据，不参与选路、不消耗断路器许可。 */
import { isProviderInAutoRouting } from "./provider-config.js";
import { getModelAvailability } from "./model-support.js";

const LIMIT = 200;
const text = (value) => String(value || "").slice(0, 160);
const identity = (provider) => ({
  providerId: text(provider?.id ?? provider?.providerId),
  providerName: text(provider?.name ?? provider?.providerName),
  priority: Number(provider?.sortIndex ?? provider?.priority) || 1,
});

export function captureRouteSnapshot({ providers, selected, proxy, routeKey, routedProviderId, model, context, stickyProviderId, circuitState, recovery }) {
  const selectedIds = new Set(selected.map((provider) => provider.id));
  const excluded = providers.filter((provider) => !selectedIds.has(provider.id)).map((provider) => {
    let reason = "not_selected";
    if (!provider.baseUrl) reason = "not_configured";
    else if (routeKey !== "cct" && provider.id !== routedProviderId) reason = "different_route";
    else if (routeKey === "cct" && proxy.autoFailoverEnabled && !isProviderInAutoRouting(provider)) reason = "routing_disabled";
    else if (routeKey === "cct" && !proxy.autoFailoverEnabled) reason = "manual_not_selected";
    else if (circuitState(provider.id) === "open") reason = "circuit_open";
    else if (getModelAvailability(provider, model).state === "unsupported") reason = "model_unsupported";
    return { ...identity(provider), reason };
  });
  return normalizeRouteSnapshot({
    version: 1, mode: proxy.autoFailoverEnabled ? "auto" : "manual", routeKey,
    model, stickyProviderId, contextProviderId: context?.previousProviderId,
    recovery,
    candidates: selected.map(identity), excluded,
    omittedCount: Math.max(0, selected.length - LIMIT) + Math.max(0, excluded.length - LIMIT),
  });
}

export function normalizeRouteSnapshot(value) {
  if (!value || value.version !== 1) return null;
  const reasons = new Set(["not_selected", "not_configured", "different_route", "routing_disabled", "manual_not_selected", "circuit_open", "model_unsupported"]);
  return {
    version: 1, mode: value.mode === "manual" ? "manual" : "auto",
    routeKey: text(value.routeKey), model: text(value.model),
    stickyProviderId: text(value.stickyProviderId), contextProviderId: text(value.contextProviderId),
    recovery: normalizeRecoveryReference(value.recovery),
    candidates: (Array.isArray(value.candidates) ? value.candidates : []).slice(0, LIMIT).map(identity),
    excluded: (Array.isArray(value.excluded) ? value.excluded : []).slice(0, LIMIT).map((provider) => ({
      ...identity(provider), reason: reasons.has(provider?.reason) ? provider.reason : "not_selected",
    })),
    omittedCount: Math.max(0, Number(value.omittedCount) || 0),
  };
}

function normalizeRecoveryReference(value) {
  const id = (input) => /^\d{17}-[a-f0-9-]{36}$/.test(input || "") ? input : "";
  if (!value || !id(value.confirmationEventId)) return null;
  return { providerId: text(value.providerId), confirmationEventId: id(value.confirmationEventId), migrationEventId: id(value.migrationEventId), confirmedAt: text(value.confirmedAt) };
}
