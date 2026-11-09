/**
 * 隔离的 413 诊断状态机。
 * 只消费一次显式 arm，不保存请求正文，并在后台完成诊断任务。
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export function createPayloadDiagnostics({
  logPath,
  runDiagnostic,
  persist = null,
  now = () => Date.now(),
  append = appendFile,
  makeDir = mkdir,
  maxErrorLength = 400,
} = {}) {
  let armed = false;
  let running = false;
  let armedAt = null;
  let last = null;
  let task = Promise.resolve();

  function arm() {
    if (running || armed) return false;
    armed = true;
    armedAt = new Date(now()).toISOString();
    return true;
  }

  function status() {
    return {
      armed,
      running,
      armedAt,
      last,
      logPath: logPath || "",
    };
  }

  async function capture(context = {}) {
    if (!armed || running) return false;
    armed = false;
    running = true;
    const capturedAt = new Date(now()).toISOString();
    // 只有显式等待时才复制正文；任务结束后立即释放引用。
    const snapshot = {
      ...context,
      body: context.body?.length ? Buffer.from(context.body) : Buffer.alloc(0),
      capturedAt,
    };
    task = Promise.resolve()
      .then(() => runDiagnostic(snapshot))
      .then((result) => finish({
        ok: true,
        capturedAt,
        finishedAt: new Date(now()).toISOString(),
        ...(result && typeof result === "object" ? result : { result }),
      }))
      .catch((error) => finish({
        ok: false,
        capturedAt,
        finishedAt: new Date(now()).toISOString(),
        error: truncate(redactDiagnosticText(error?.message || String(error)), maxErrorLength),
      }))
      .finally(() => {
        snapshot.body = null;
        running = false;
      });
    return true;
  }

  async function finish(result) {
    last = result;
    if (persist) {
      try { await persist(result); }
      catch (error) {
        last = { ...result, logError: truncate(redactDiagnosticText(error?.message || String(error)), maxErrorLength) };
      }
      return;
    }
    if (!logPath) return;
    try {
      await makeDir(path.dirname(logPath), { recursive: true });
      await append(logPath, `${JSON.stringify(result)}\n`, "utf8");
    } catch (error) {
      last = {
        ...result,
        logError: truncate(redactDiagnosticText(error?.message || String(error)), maxErrorLength),
      };
    }
  }

  return { arm, capture, status, flush: () => task };
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function redactDiagnosticText(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已脱敏]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[已脱敏]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[已脱敏]");
}
