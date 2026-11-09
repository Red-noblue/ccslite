/**
 * 中文交接事件日志：合并高频请求完成事件，批量落盘并按大小轮换文件。
 * 该模块只负责交接审计日志，不参与请求转发、用量记录或版本切换。
 */
import { chmod, mkdir, open, rename, stat, lstat } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const MODE = 0o600;
const CURRENT_NAME = "handoff-events.jsonl";
const ARCHIVE_PREFIX = "handoff-events.";

function formatArchiveTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function numeric(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function createHandoffJournal({
  directory,
  supervisorPid = process.pid,
  intervalMs = 1000,
  batchSize = 128,
  maxBytes = 16 * 1024 * 1024,
  onError = () => {},
} = {}) {
  if (!directory) throw new TypeError("交接日志目录不能为空");
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new TypeError("日志合并间隔必须是正整数");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError("日志批量阈值必须是正整数");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError("日志轮换大小必须是正整数");

  const currentPath = path.join(directory, CURRENT_NAME);
  let currentBytes = 0;
  let archiveCount = 0;
  let lastRotationAt = null;
  let lastFlushAt = null;
  let errorMessage = null;
  let pending = [];
  let summary = null;
  let flushTimer = null;
  let flushChain = Promise.resolve();
  let closed = false;

  try {
    const info = lstatSync(currentPath);
    if (info.isSymbolicLink()) throw new Error("交接事件日志不能通过软链接写入其他位置");
    currentBytes = statSync(currentPath).size;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    archiveCount = readdirSync(directory).filter((name) => name.startsWith(ARCHIVE_PREFIX) && name.endsWith(".jsonl")).length;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const reportError = (error) => {
    errorMessage = error.message;
    try { onError(error); } catch { /* 日志错误回调不能影响服务。 */ }
  };
  const scheduleFlush = (delay = intervalMs) => {
    if (closed || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delay);
    flushTimer.unref?.();
  };
  const materializeSummary = () => {
    if (!summary || summary.completedRequests < 1) return;
    const now = new Date();
    pending.push({
      timestamp: now.toISOString(),
      supervisorPid,
      event: "handoff_request_summary",
      intervalStartedAt: summary.intervalStartedAt,
      intervalEndedAt: now.toISOString(),
      completedRequests: summary.completedRequests,
      maxInFlight: summary.maxInFlight,
      maxQueuedRequests: summary.maxQueuedRequests,
      maxQueuedBytes: summary.maxQueuedBytes,
    });
    summary = null;
  };
  const ensureCurrentFile = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(currentPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error("交接事件日志不能通过软链接写入其他位置");
    currentBytes = info ? (await stat(currentPath)).size : 0;
  };
  const nextArchivePath = async () => {
    const stem = `${ARCHIVE_PREFIX}${formatArchiveTime(new Date())}-${supervisorPid}`;
    let suffix = 0;
    while (true) {
      const candidate = path.join(directory, `${stem}${suffix ? `-${suffix}` : ""}.jsonl`);
      if (!existsSync(candidate)) return candidate;
      suffix += 1;
    }
  };
  const rotate = async () => {
    if (!currentBytes) return;
    const archivePath = await nextArchivePath();
    await rename(currentPath, archivePath);
    await chmod(archivePath, MODE);
    archiveCount += 1;
    lastRotationAt = new Date().toISOString();
    currentBytes = 0;
  };
  const append = async (lines) => {
    if (!lines.length) return;
    await ensureCurrentFile();
    let index = 0;
    while (index < lines.length) {
      let payload = "";
      let bytes = 0;
      while (index < lines.length) {
        const line = `${JSON.stringify(lines[index])}\n`;
        const lineBytes = Buffer.byteLength(line);
        if (payload && currentBytes + bytes + lineBytes > maxBytes) break;
        if (!payload && currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
          await rotate();
        }
        payload += line;
        bytes += lineBytes;
        index += 1;
      }
      const file = await open(currentPath, "a", MODE);
      try {
        await file.chmod(MODE);
        await file.writeFile(payload);
        await file.sync();
      } finally {
        await file.close();
      }
      currentBytes += bytes;
    }
  };
  const flush = () => {
    if (closed && !pending.length && !summary) return flushChain;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    materializeSummary();
    const task = flushChain.catch(() => {}).then(async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      try {
        await append(batch);
        errorMessage = null;
        lastFlushAt = new Date().toISOString();
      } catch (error) {
        pending = [...batch, ...pending];
        reportError(error);
        scheduleFlush(intervalMs);
      }
    });
    flushChain = task.catch(() => {});
    return task;
  };

  return {
    record(details) {
      if (closed || !details?.event) return;
      const now = new Date().toISOString();
      if (details.event === "handoff_request_finished") {
        summary ??= { intervalStartedAt: now, completedRequests: 0, maxInFlight: 0, maxQueuedRequests: 0, maxQueuedBytes: 0 };
        summary.completedRequests += 1;
        summary.maxInFlight = Math.max(summary.maxInFlight, numeric(details.inFlight));
        summary.maxQueuedRequests = Math.max(summary.maxQueuedRequests, numeric(details.queuedRequests));
        summary.maxQueuedBytes = Math.max(summary.maxQueuedBytes, numeric(details.queuedBytes));
        if (summary.completedRequests >= batchSize) void flush();
        else scheduleFlush();
        return;
      }
      pending.push({ timestamp: now, supervisorPid, ...details });
      if (pending.length >= batchSize) void flush();
      else scheduleFlush();
    },
    flush,
    async close() {
      if (closed) return flushChain;
      closed = true;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      materializeSummary();
      const result = flush();
      await result;
      await flushChain;
      return flushChain;
    },
    state() {
      return {
        pendingEvents: pending.length + (summary?.completedRequests || 0),
        currentFile: currentPath,
        currentFileBytes: currentBytes,
        maxBytes,
        archiveCount,
        lastRotationAt,
        lastFlushAt,
        journalError: errorMessage,
      };
    },
  };
}
