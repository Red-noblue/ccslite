/**
 * 分组用量归属与运行统计：旧日志只归入默认分组，新分组按独立标识从零统计。
 */
import { isProviderTestUsageRecord } from "./usage-records.js";

export function usageGroupId(record) {
  return String(record?.groupId || "default");
}

function emptyStatistics() {
  return {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    failoverCount: 0,
    activeConnections: 0,
    streamDiagnostics: {
      streamAttempts: 0,
      streamFailures: 0,
      preOutputFailures: 0,
      preOutputFailovers: 0,
      midStreamDisconnects: 0,
      transportErrors: 0,
      clientDisconnects: 0,
      idleTimeouts: 0,
      progressTimeouts: 0,
      firstByteSamples: 0,
      firstByteTotalMs: 0,
      latestFirstByteAt: null,
      latestLastChunkAt: null,
      latestFailureAt: null,
    },
  };
}

function isLaterSuccessfulAttempt(attempts, index) {
  return attempts.slice(index + 1).some((attempt) => attempt?.outcome === "success");
}

function addStreamDiagnostics(statistics, record) {
  if (!record?.isStreaming) return;
  const attempts = Array.isArray(record?.providerAttempts) ? record.providerAttempts : [];
  const summary = statistics.streamDiagnostics;
  attempts.forEach((attempt, index) => {
    const diagnostics = attempt?.streamDiagnostics;
    if (attempt?.outcome === "skipped") return;
    summary.streamAttempts += 1;

    if (Number.isFinite(diagnostics?.firstByteLatencyMs)) {
      summary.firstByteSamples += 1;
      summary.firstByteTotalMs += diagnostics.firstByteLatencyMs;
    }
    if (diagnostics?.firstByteAt) {
      if (!summary.latestFirstByteAt || diagnostics.firstByteAt > summary.latestFirstByteAt) {
        summary.latestFirstByteAt = diagnostics.firstByteAt;
      }
    }
    if (diagnostics?.lastChunkAt && (!summary.latestLastChunkAt || diagnostics.lastChunkAt > summary.latestLastChunkAt)) {
      summary.latestLastChunkAt = diagnostics.lastChunkAt;
    }
    if (attempt.outcome !== "failure") return;
    summary.streamFailures += 1;
    const clientDisconnected = attempt.failureClass === "client_connection_closed" ||
      String(diagnostics?.termination || "").startsWith("client_connection_closed");
    if (clientDisconnected) summary.clientDisconnects += 1;
    if (attempt.failureClass === "operator_cancelled" || clientDisconnected) return;
    const outputStarted = Boolean(diagnostics?.outputStarted || Number(diagnostics?.forwardedBytes || 0) > 0);
    if (outputStarted) summary.midStreamDisconnects += 1;
    else if (isLaterSuccessfulAttempt(attempts, index)) summary.preOutputFailovers += 1;
    else summary.preOutputFailures += 1;
    if (attempt.failureClass === "transport") summary.transportErrors += 1;
    if (String(diagnostics?.termination || "") === "upstream_idle_timeout") summary.idleTimeouts += 1;
    if (String(diagnostics?.termination || "") === "upstream_progress_timeout") summary.progressTimeouts += 1;
    // 使用已落盘的尝试结束时间，避免实时统计和重启恢复使用不同的请求完成时间。
    const startedAtMs = Date.parse(attempt.startedAt);
    const failureAt = Number.isFinite(startedAtMs) && Number.isFinite(attempt.latencyMs)
      ? new Date(startedAtMs + Math.max(0, attempt.latencyMs)).toISOString()
      : record.timestamp || attempt.startedAt || null;
    if (failureAt && (!summary.latestFailureAt || failureAt > summary.latestFailureAt)) {
      summary.latestFailureAt = failureAt;
    }
  });
}

export function createGroupStatistics() {
  const groups = new Map();
  const get = (groupId) => {
    if (!groups.has(groupId)) groups.set(groupId, emptyStatistics());
    return groups.get(groupId);
  };
  function addResult(statistics, record) {
    if (record.statusCode >= 200 && record.statusCode < 400 && !record.error) statistics.successRequests += 1;
    else statistics.failedRequests += 1;
    if ((record.providerAttempts || []).some((attempt) => attempt.sequence > 1 && attempt.outcome === "success")) statistics.failoverCount += 1;
    addStreamDiagnostics(statistics, record);
  }
  function record(record) {
    if (isProviderTestUsageRecord(record)) return;
    const statistics = get(usageGroupId(record));
    statistics.totalRequests += 1;
    addResult(statistics, record);
  }
  function restore(records) {
    groups.clear();
    records.forEach(record);
  }
  function start(groupId) {
    const statistics = get(groupId);
    statistics.totalRequests += 1;
    statistics.activeConnections += 1;
    let finished = false;
    return (result) => {
      if (finished) return;
      finished = true;
      statistics.activeConnections -= 1;
      addResult(statistics, result);
    };
  }
  function snapshot(groupId) {
    const statistics = groups.get(groupId) || emptyStatistics();
    return {
      ...statistics,
      streamDiagnostics: {
        ...statistics.streamDiagnostics,
        firstByteAverageMs: statistics.streamDiagnostics.firstByteSamples
          ? statistics.streamDiagnostics.firstByteTotalMs / statistics.streamDiagnostics.firstByteSamples
          : null,
      },
      successRate: statistics.totalRequests ? statistics.successRequests / statistics.totalRequests * 100 : 0,
    };
  }
  return { restore, record, start, snapshot };
}
