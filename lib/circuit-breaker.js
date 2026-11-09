/**
 * 供应商断路器状态机。
 * 负责关闭、开启和半开探测状态，不依赖服务器全局配置。
 */

export class CircuitBreaker {
  constructor(providerId, breakerConfig) {
    this.providerId = providerId;
    this.updateConfig(breakerConfig);
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.totalRequests = 0;
    this.failedRequests = 0;
    this.lastOpenedAt = null;
    this.halfOpenInFlight = 0;
  }

  updateConfig(breakerConfig) {
    this.config = {
      failureThreshold: positiveInt(breakerConfig?.failureThreshold, 4),
      successThreshold: positiveInt(breakerConfig?.successThreshold, 2),
      openTimeoutMs: positiveInt(breakerConfig?.openTimeoutMs, 60_000),
      errorRateThreshold: clampNumber(breakerConfig?.errorRateThreshold, 0.6, 0, 1),
      minRequests: positiveInt(breakerConfig?.minRequests, 10),
    };
  }

  isAvailable() {
    if (this.state === "closed" || this.state === "half_open") return true;
    if (!this.lastOpenedAt) return false;
    if (Date.now() - this.lastOpenedAt >= this.config.openTimeoutMs) {
      this.transitionToHalfOpen();
      return true;
    }
    return false;
  }

  allowRequest() {
    if (this.state === "closed") {
      return { allowed: true, usedHalfOpenPermit: false };
    }
    if (this.state === "open") {
      if (this.isAvailable()) return this.allowHalfOpenProbe();
      return { allowed: false, usedHalfOpenPermit: false };
    }
    return this.allowHalfOpenProbe();
  }

  allowHalfOpenProbe() {
    if (this.halfOpenInFlight > 0) {
      return { allowed: false, usedHalfOpenPermit: false };
    }
    this.halfOpenInFlight += 1;
    return { allowed: true, usedHalfOpenPermit: true };
  }

  releaseHalfOpenPermit(usedHalfOpenPermit) {
    if (usedHalfOpenPermit) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
  }

  recordSuccess(usedHalfOpenPermit) {
    this.releaseHalfOpenPermit(usedHalfOpenPermit);
    this.consecutiveFailures = 0;
    this.totalRequests += 1;
    if (this.state === "half_open") {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionToClosed();
      }
    }
  }

  recordFailure(usedHalfOpenPermit) {
    this.releaseHalfOpenPermit(usedHalfOpenPermit);
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    this.totalRequests += 1;
    this.failedRequests += 1;

    if (this.state === "half_open") {
      this.transitionToOpen();
      return;
    }

    if (this.state === "closed") {
      const errorRate = this.failedRequests / Math.max(1, this.totalRequests);
      const hitConsecutiveThreshold =
        this.consecutiveFailures >= this.config.failureThreshold;
      const hitErrorRateThreshold =
        this.totalRequests >= this.config.minRequests &&
        errorRate >= this.config.errorRateThreshold;
      if (hitConsecutiveThreshold || hitErrorRateThreshold) {
        this.transitionToOpen();
      }
    }
  }

  reset() {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.totalRequests = 0;
    this.failedRequests = 0;
    this.lastOpenedAt = null;
    this.halfOpenInFlight = 0;
  }

  // CCOK 主动探测不属于真实业务请求；只恢复临时健康状态，不清空历史统计。
  recordProbeSuccess() {
    this.transitionToClosed();
  }

  // 主动探测已明确失败时，立即让后续自动路由暂时跳过该供应商。
  recordProbeFailure() {
    this.transitionToOpen();
  }

  transitionToClosed() {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastOpenedAt = null;
    this.halfOpenInFlight = 0;
  }

  transitionToOpen() {
    this.state = "open";
    this.lastOpenedAt = Date.now();
    this.halfOpenInFlight = 0;
  }

  transitionToHalfOpen() {
    this.state = "half_open";
    this.consecutiveSuccesses = 0;
    this.halfOpenInFlight = 0;
  }

  stats() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      errorRate: this.totalRequests > 0 ? this.failedRequests / this.totalRequests : 0,
      lastOpenedAt: this.lastOpenedAt
        ? new Date(this.lastOpenedAt).toISOString()
        : null,
      halfOpenInFlight: this.halfOpenInFlight,
    };
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
