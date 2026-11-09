#!/usr/bin/env node
/**
 * 中文固定监听交接入口：启动公开端口交接层和候选工作进程，支持观察期回退。
 * 支持版本包模式和源码模式：源码模式从本目录启动主工作进程，回退仍使用独立验收包。
 * 不会修改 CC Switch，也不会自行创建正式数据副本。
 */
import { createHandoffSupervisor } from "./lib/handoff-supervisor.js";
import { createHandoffControl, requestHandoffControl } from "./lib/handoff-control.js";
import { readHandoffEvents } from "./lib/handoff-events-cli.js";
import { shouldPrintHandoffLog } from "./lib/handoff-terminal-log.js";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage(message = "") {
  if (message) console.error(`参数错误：${message}`);
  console.error("用法：node handoff-runner.mjs --workspace [--fallback <目录>] [--data-dir <目录>] [--port <端口>] [--host 127.0.0.1] [--observe-ms 毫秒]");
  console.error("或：node handoff-runner.mjs --candidate <目录> --fallback <目录> --data-dir <目录> --port <端口> [--host 127.0.0.1] [--observe-ms 毫秒]");
  console.error("运行中控制：node handoff-runner.mjs <status|events|upgrade-session|upgrade|rollback> --data-dir <目录> [--candidate <新版本目录>]");
  console.error("事件查询：node handoff-runner.mjs events --data-dir <目录> [--tail <数量>] [--event <事件名>]");
  console.error("upgrade-session 在每个会话当前请求及检查点完成后逐步交接；upgrade 等待整体排空。");
  console.error("前置器协议变更必须在维护窗口重启前置器；只升级工作进程不会加载新的前置器代码。");
  process.exitCode = 2;
}

// 源码模式只接受 fallback-releases 下唯一的回退目录，避免升级后继续绑定旧目录名。
function resolveWorkspaceFallback(root, explicit) {
  if (explicit) return explicit;
  const directory = path.join(root, "fallback-releases");
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  if (entries.length !== 1) {
    throw new Error(`源码模式要求 fallback-releases 只包含一个回退目录，当前找到 ${entries.length} 个`);
  }
  return path.join(directory, entries[0].name);
}

function parseArgs(argv) {
  const workspace = argv.includes("--workspace");
  argv = argv.filter((value) => value !== "--workspace");
  const action = ["status", "events", "upgrade-session", "upgrade", "rollback"].includes(argv[0]) ? argv.shift() : "run";
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!["--candidate", "--fallback", "--data-dir", "--port", "--host", "--observe-ms", "--tail", "--event"].includes(key) || value === undefined || values[key]) throw new Error(`未知、重复或缺少值的参数：${key || ""}`);
    values[key] = value;
  }
  if (action !== "run") {
    const allowed = ["upgrade", "upgrade-session"].includes(action) ? ["--data-dir", "--candidate"] :
      action === "events" ? ["--data-dir", "--tail", "--event"] : ["--data-dir"];
    const required = action === "events" ? ["--data-dir"] : allowed;
    if (Object.keys(values).some((key) => !allowed.includes(key)) || required.some((key) => !values[key])) throw new Error(`${action} 需要参数：${required.join("、")}`);
    return { action, dataDir: values["--data-dir"], candidate: values["--candidate"], tail: values["--tail"], event: values["--event"] };
  }
  if (workspace) {
    if (Object.keys(values).some((key) => key === "--candidate")) throw new Error("源码模式不能指定 --candidate");
    const root = path.dirname(fileURLToPath(import.meta.url));
    return { action, candidate: root, fallback: resolveWorkspaceFallback(root, values["--fallback"]), dataDir: values["--data-dir"] || path.join(root, "data"),
      publicPort: Number(values["--port"] || 15720), host: values["--host"] || "127.0.0.1",
      observeMs: values["--observe-ms"] === undefined ? 30_000 : Number(values["--observe-ms"]), workspaceCandidate: true };
  }
  const required = ["--candidate", "--fallback", "--data-dir", "--port"];
  for (const key of required) if (!values[key]) throw new Error(`缺少参数：${key}`);
  const port = Number(values["--port"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port 必须是有效端口");
  const observeMs = values["--observe-ms"] === undefined ? 30_000 : Number(values["--observe-ms"]);
  if (!Number.isInteger(observeMs) || observeMs < 0) throw new Error("--observe-ms 必须是非负整数");
  return { action, candidate: values["--candidate"], fallback: values["--fallback"], dataDir: values["--data-dir"], publicPort: port,
    host: values["--host"] || "127.0.0.1", observeMs };
}

let supervisor;
let control;
let stopping = false;
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.action !== "run") {
    if (options.action === "events") {
      const result = await readHandoffEvents(options.dataDir, { tail: options.tail, event: options.event });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      process.exitCode = 0;
    } else {
      const result = await requestHandoffControl(options.dataDir, { action: options.action, candidate: options.candidate });
      console.log(JSON.stringify(result));
    }
  } else {
  supervisor = await createHandoffSupervisor({ ...options, log: (line) => {
    if (shouldPrintHandoffLog(line)) console.log(`[lite-handoff] ${line}`);
  } });
  const stop = async (signal) => {
    if (stopping) { supervisor.forceClose(); process.exitCode = 130; return; }
    stopping = true;
    console.log(JSON.stringify({ event: "stopping", signal }));
    try { await control?.close(); await supervisor.close(); console.log(JSON.stringify({ event: "stopped" })); }
    catch (error) { console.error(`[lite-handoff] 停止失败：${error.message}`); process.exitCode = 1; }
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  const worker = await supervisor.start();
  if (!stopping) {
    control = await createHandoffControl({ dataDir: options.dataDir, supervisor });
    if (stopping) await control.close();
    else console.log(JSON.stringify({ event: "ready", worker: worker.id, pid: worker.pid, publicPort: options.publicPort, control: control.socketPath, state: supervisor.state() }));
  }
  }
} catch (error) {
  await control?.close().catch(() => {}); await supervisor?.close().catch(() => {});
  if (!stopping) usage(error.message);
}
