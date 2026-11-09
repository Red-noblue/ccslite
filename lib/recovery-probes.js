/**
 * 供应商恢复探测调度器。
 * 每个供应商最多同时运行一个 CCOK 探测；同模型的业务与探测成功共同确认恢复。
 */

export function createRecoveryProbeManager({
  intervalMs = 5_000,
  requiredSuccesses = 2,
  maxConsecutiveFailures = 12,
  pausedIntervalMs = 60_000,
  getModel,
  testProvider,
  onRecovered = () => {},
  onFailed = () => {},
  shouldProbe = () => true,
  log = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const states = new Map();
  let stopped = false;

  function stateFor(provider) {
    const id = String(provider?.id || "");
    if (!id) return null;
    if (!states.has(id)) {
      states.set(id, {
        providerId: id,
        providerName: String(provider?.name || id),
        provider,
        timer: null,
        running: false,
        successStreak: 0,
        consecutiveFailures: 0,
        scheduledAt: null,
        lastResult: null,
        successModel: "",
        reason: "",
        cancelRequested: false,
        targetModel: "",
        probeModel: "",
        evidence: new Map(),
        lastConfirmedAt: null,
        lastConfirmedSource: "",
        pendingModels: new Set(),
      });
    }
    const state = states.get(id);
    state.provider = provider;
    state.providerName = String(provider?.name || id);
    return state;
  }

  function schedule(provider, reason = "", model = "") {
    if (stopped) return false;
    const state = stateFor(provider);
    if (!state || !isEligible(provider)) return false;
    const normalizedModel = String(model || "").trim();
    if (normalizedModel) state.pendingModels.add(normalizedModel);
    if (state.running || state.timer) return false;
    state.cancelRequested = false;
    state.reason = String(reason || "");
    state.targetModel = state.pendingModels.values().next().value || "";
    const failures = state.consecutiveFailures;
    const delay = failures >= maxConsecutiveFailures ? pausedIntervalMs : intervalMs;
    state.scheduledAt = now() + delay;
    state.timer = setTimer(() => {
      state.timer = null;
      state.scheduledAt = null;
      run(state).catch((error) => {
        log(`恢复探测异常（${state.providerName}）：${error?.message || error}`);
        scheduleAfterFailure(state);
      });
    }, delay);
    state.timer?.unref?.();
    return true;
  }

  function scheduleAfterFailure(state) {
    if (stopped || state.running || state.timer || state.cancelRequested && !state.pendingModels.size) return;
    schedule(state.provider, state.reason);
  }

  // 业务和探测共用按模型保存的证据；达到阈值前仍保留后台确认，避免粘滞永久不回迁。
  async function recordSuccess(provider, model, result = {}) {
    const normalizedModel = String(model || "").trim();
    if (stopped || !normalizedModel || !isEligible(provider)) return false;
    const state = stateFor(provider);
    if (!state) return false;
    const evidence = state.evidence.get(normalizedModel) || { successes: 0, confirmed: false };
    if (evidence.confirmed) return false;
    state.evidence.set(normalizedModel, evidence);
    evidence.lastSource = String(result?.source || "unknown");
    evidence.successes += 1;
    state.successModel = normalizedModel;
    state.successStreak = evidence.successes;
    state.consecutiveFailures = 0;
    state.lastResult = { ...result, ok: true, model: normalizedModel, checkedAt: new Date(now()).toISOString() };
    if (evidence.successes < requiredSuccesses) return false;
    evidence.confirmed = true;
    evidence.confirmedAt = new Date(now()).toISOString();
    state.lastConfirmedAt = evidence.confirmedAt;
    state.lastConfirmedSource = evidence.lastSource;
    state.pendingModels.delete(normalizedModel);
    state.successStreak = 0;
    state.successModel = "";
    // 其他模型恢复不能取消目标模型的探测；在途结果也不能再次触发同一轮回迁。
    const targetModel = state.probeModel || state.targetModel || normalizedModel;
    if (targetModel === normalizedModel) {
      if (state.timer) clearTimer(state.timer);
      state.timer = null;
      state.scheduledAt = null;
      state.cancelRequested = true;
      state.reason = "";
    }
    await onRecovered(state.provider, state.lastResult);
    if (targetModel === normalizedModel && state.pendingModels.size) scheduleAfterFailure(state);
    return true;
  }

  function resetEvidence(providerOrId, model = "") {
    const id = typeof providerOrId === "object" ? providerOrId?.id : providerOrId;
    const state = states.get(String(id || ""));
    if (!state) return;
    if (model) state.evidence.delete(String(model).trim());
    else state.evidence.clear();
    if (!model || state.successModel === model) {
      state.successStreak = 0;
      state.successModel = "";
    }
  }

  // 删除、停用或显式检测完成时取消调度；普通业务成功通过 recordSuccess 累计证据。
  function cancel(provider) {
    const state = states.get(String(provider?.id || ""));
    if (!state) return false;
    if (state.timer) clearTimer(state.timer);
    state.timer = null;
    state.scheduledAt = null;
    state.successStreak = 0;
    state.successModel = "";
    state.consecutiveFailures = 0;
    state.reason = "";
    state.cancelRequested = true;
    state.targetModel = "";
    state.pendingModels.clear();
    resetEvidence(provider);
    return true;
  }

  async function run(state) {
    if (stopped || state.running) return;
    state.running = true;
    state.cancelRequested = false;
    try {
      if (!isEligible(state.provider)) {
        state.cancelRequested = true;
        return;
      }
      const model = state.targetModel || await getModel(state.provider);
      if (state.cancelRequested || stopped) return;
      if (!model) {
        state.successStreak = 0;
        state.successModel = "";
        state.consecutiveFailures += 1;
        state.lastResult = { ok: false, message: "没有可用探测模型" };
        return;
      }
      const normalizedModel = String(model || "").trim();
      state.probeModel = normalizedModel;
      const result = await testProvider(state.provider, model);
      if (state.cancelRequested) return;
      state.lastResult = {
        ok: Boolean(result?.ok),
        status: Number(result?.status || 0),
        model,
        message: String(result?.message || ""),
        checkedAt: new Date(now()).toISOString(),
      };
      if (result?.ok) {
        await recordSuccess(state.provider, normalizedModel, { ...state.lastResult, source: "probe" });
      } else {
        resetEvidence(state.provider, normalizedModel);
        state.consecutiveFailures += 1;
        await onFailed(state.provider, state.lastResult);
      }
    } finally {
      state.running = false;
      state.probeModel = "";
      scheduleAfterFailure(state);
    }
  }

  function stop() {
    stopped = true;
    for (const state of states.values()) {
      if (state.timer) clearTimer(state.timer);
      state.timer = null;
      state.scheduledAt = null;
    }
  }

  function status() {
    return [...states.values()].map((state) => ({
      providerId: state.providerId,
      providerName: state.providerName,
      running: state.running,
      scheduledAt: state.scheduledAt ? new Date(state.scheduledAt).toISOString() : null,
      successStreak: state.successStreak,
      successModel: state.successModel,
      consecutiveFailures: state.consecutiveFailures,
      lastResult: state.lastResult,
      recoveryConfirmed: [...state.evidence.values()].some((evidence) => evidence.confirmed),
      confirmedModels: [...state.evidence.entries()]
        .filter(([, evidence]) => evidence.confirmed)
        .map(([model, evidence]) => ({ model, confirmedAt: evidence.confirmedAt || null, source: evidence.lastSource || "unknown" })),
      lastConfirmedAt: state.lastConfirmedAt,
      lastConfirmedSource: state.lastConfirmedSource,
      reason: state.reason,
      pendingModels: [...state.pendingModels],
    }));
  }

  return { schedule, recordSuccess, resetEvidence, cancel, stop, status };

  function isEligible(provider) {
    try {
      return shouldProbe(provider) !== false;
    } catch (error) {
      log(`恢复探测资格判断异常：${error?.message || error}`);
      return false;
    }
  }
}
