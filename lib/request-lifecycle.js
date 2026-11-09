/**
 * 代理请求生命周期登记器。
 * 只保存排障所需的请求元数据，不保存请求正文、认证头或令牌。
 */

import crypto from "node:crypto";

function asText(value) {
  return value === undefined || value === null ? "" : String(value);
}

function asPositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

export function createRequestLifecycleRegistry({ now = Date.now, onChange = () => {} } = {}) {
  const entries = new Map();

  function start(metadata = {}) {
    const startedAtMs = now();
    const entry = {
      id: crypto.randomUUID(),
      requestId: asText(metadata.requestId),
      attempt: asPositiveInt(metadata.attempt),
      groupId: asText(metadata.groupId || "default"),
      providerId: asText(metadata.providerId),
      providerName: asText(metadata.providerName),
      model: asText(metadata.model),
      endpoint: asText(metadata.endpoint),
      clientAddress: asText(metadata.clientAddress),
      clientPort: asPositiveInt(metadata.clientPort),
      upstreamHost: "",
      stream: Boolean(metadata.stream),
      state: asText(metadata.state || "connecting"),
      startedAtMs,
      firstByteAtMs: null,
      clientFirstByteAtMs: null,
      lastChunkAtMs: null,
      lastProgressAtMs: null,
      lastChunkBytes: 0,
      totalBytes: 0,
      chunkCount: 0,
      semanticStarted: false,
      completed: false,
      cancelRequested: false,
      terminationReason: "",
      abort: null,
    };
    entries.set(entry.id, entry);
    onChange();

    let finished = false;
    let cancelled = false;

    const handle = {
      id: entry.id,
      setAbort(abort) {
        entry.abort = typeof abort === "function" ? abort : null;
        if (cancelled) entry.abort?.();
      },
      update(patch = {}) {
        if (finished) return;
        if (patch.state !== undefined) entry.state = asText(patch.state);
        if (patch.upstreamHost !== undefined) entry.upstreamHost = asText(patch.upstreamHost);
        if (patch.stream !== undefined) entry.stream = Boolean(patch.stream);
        if (patch.semanticStarted !== undefined) entry.semanticStarted = Boolean(patch.semanticStarted);
        onChange();
      },
      observeChunk(bytes, patch = {}) {
        if (finished) return;
        const size = asPositiveInt(bytes);
        const timestamp = now();
        entry.firstByteAtMs ??= timestamp;
        entry.lastChunkAtMs = timestamp;
        entry.lastChunkBytes = size;
        entry.totalBytes += size;
        entry.chunkCount += 1;
        if (patch.progress) entry.lastProgressAtMs = timestamp;
        if (patch.semanticStarted !== undefined) entry.semanticStarted = Boolean(patch.semanticStarted);
        if (patch.completed !== undefined) entry.completed = Boolean(patch.completed);
        if (patch.state !== undefined) entry.state = asText(patch.state);
        else if (entry.semanticStarted) entry.state = "streaming";
      },
      markClientOutputStarted() {
        if (finished) return;
        entry.clientFirstByteAtMs ??= now();
        onChange();
      },
      timingDiagnostics() {
        return {
          firstByteAt: toIso(entry.firstByteAtMs),
          lastChunkAt: toIso(entry.lastChunkAtMs),
          lastProgressAt: toIso(entry.lastProgressAtMs),
          firstByteLatencyMs: entry.firstByteAtMs === null
            ? null
            : Math.max(0, entry.firstByteAtMs - entry.startedAtMs),
          clientFirstByteLatencyMs: entry.clientFirstByteAtMs === null
            ? null
            : Math.max(0, entry.clientFirstByteAtMs - entry.startedAtMs),
          lastDataLatencyMs: entry.lastChunkAtMs === null
            ? null
            : Math.max(0, entry.lastChunkAtMs - entry.startedAtMs),
          outputStarted: entry.clientFirstByteAtMs !== null,
        };
      },
      isCancelled() {
        return cancelled;
      },
      cancel(reason = "operator_cancelled") {
        if (finished || cancelled) return false;
        cancelled = true;
        entry.cancelRequested = true;
        entry.terminationReason = asText(reason);
        entry.state = "cancelling";
        entry.abort?.();
        onChange();
        return true;
      },
      finish(patch = {}) {
        if (finished) return false;
        finished = true;
        if (patch.state !== undefined) entry.state = asText(patch.state);
        if (patch.completed !== undefined) entry.completed = Boolean(patch.completed);
        if (patch.terminationReason !== undefined) entry.terminationReason = asText(patch.terminationReason);
        entry.finishedAtMs = now();
        entry.durationMs = Math.max(0, entry.finishedAtMs - entry.startedAtMs);
        entries.delete(entry.id);
        onChange();
        return true;
      },
    };

    entry.handle = handle;
    return handle;
  }

  function serialize(entry, nowMs, idleTimeoutMs = 0) {
    const lastActivityAtMs = entry.lastChunkAtMs || entry.startedAtMs;
    const ageMs = Math.max(0, nowMs - entry.startedAtMs);
    const idleMs = Math.max(0, nowMs - lastActivityAtMs);
    return {
      id: entry.id,
      requestId: entry.requestId,
      attempt: entry.attempt,
      groupId: entry.groupId,
      providerId: entry.providerId,
      providerName: entry.providerName,
      model: entry.model,
      endpoint: entry.endpoint,
      clientAddress: entry.clientAddress,
      clientPort: entry.clientPort || null,
      upstreamHost: entry.upstreamHost,
      stream: entry.stream,
      state: entry.state,
      startedAt: toIso(entry.startedAtMs),
      firstByteAt: toIso(entry.firstByteAtMs),
      firstByteLatencyMs: entry.firstByteAtMs === null
        ? null
        : Math.max(0, entry.firstByteAtMs - entry.startedAtMs),
      clientFirstByteAt: toIso(entry.clientFirstByteAtMs),
      clientFirstByteLatencyMs: entry.clientFirstByteAtMs === null
        ? null
        : Math.max(0, entry.clientFirstByteAtMs - entry.startedAtMs),
      lastChunkAt: toIso(entry.lastChunkAtMs),
      lastProgressAt: toIso(entry.lastProgressAtMs),
      noProgressMs: entry.firstByteAtMs === null ? null : Math.max(0, nowMs - (entry.lastProgressAtMs ?? entry.firstByteAtMs)),
      lastChunkBytes: entry.lastChunkBytes,
      totalBytes: entry.totalBytes,
      chunkCount: entry.chunkCount,
      semanticStarted: entry.semanticStarted,
      completed: entry.completed,
      cancelRequested: entry.cancelRequested,
      terminationReason: entry.terminationReason,
      ageMs,
      idleMs,
      stale: Boolean(entry.stream && idleTimeoutMs > 0 && idleMs >= idleTimeoutMs),
    };
  }

  function snapshot({ groupId = null, idleTimeoutMs = 0 } = {}) {
    const nowMs = now();
    return [...entries.values()]
      .filter((entry) => groupId === null || entry.groupId === groupId)
      .map((entry) => serialize(entry, nowMs, idleTimeoutMs));
  }

  function get(id, options = {}) {
    const entry = entries.get(String(id || ""));
    return entry ? serialize(entry, now(), options.idleTimeoutMs || 0) : null;
  }

  function cancel(id, reason = "operator_cancelled") {
    const entry = entries.get(String(id || ""));
    if (!entry) return null;
    const accepted = entry.handle?.cancel?.(reason);
    return accepted ? serialize(entry, now()) : serialize(entry, now());
  }

  function stats({ groupId = null, idleTimeoutMs = 0 } = {}) {
    const requests = snapshot({ groupId, idleTimeoutMs });
    return {
      active: requests.length,
      stale: requests.filter((request) => request.stale).length,
      oldestStartedAt: requests.reduce((oldest, request) => {
        if (!oldest || request.startedAt < oldest) return request.startedAt;
        return oldest;
      }, null),
      requests,
    };
  }

  return { start, snapshot, stats, get, cancel };
}

