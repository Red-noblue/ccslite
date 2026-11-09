#!/usr/bin/env node
/**
 * 中文版本工具入口：创建、校验独立版本包，并在新端口启动带一次自动回退的服务。
 * 不替换源码、不停止占用端口的进程、不恢复历史用量文件。
 */
import { createReleaseSnapshot, verifyReleaseSnapshot } from "./lib/release-snapshot.js";
import { runRelease } from "./lib/release-runner.js";

const [command, ...args] = process.argv.slice(2);
const help = `用法：node release.mjs <命令>
  snapshot <源码目录> <新版本目录> <版本标识>  创建独立版本包（含依赖，不含业务数据）
  verify <版本目录>                         校验文件完整性与平台
  run <候选目录> --fallback <回退目录> --data-dir <数据目录> --port <端口>
      [--host 127.0.0.1] [--startup-timeout-ms 15000]
  run 需使用既有 version=2 配置；端口已占用时直接退出，不停止现有服务。
  启动或意外退出失败时最多回退一次；Ctrl+C/SIGTERM 正常排空，不触发回退。
  就绪后持续检查本机状态：检查后间隔 5 秒，单次 1 秒，连续 3 次失败时提示异常。
  健康异常仅记录，恢复后提示恢复；正常停止时先取消观察，再等待连接排空。
  未就绪版本停止无响应时，3 秒后仅清理本次子进程；正常停止不设强制时限。
  原监督器与子进程均已退出时可归档新格式旧锁；仍在运行或排空时拒绝接管。
  生产版本包应放在固定目录；停止时向监督器发送一次 SIGTERM，待排空退出后重新 run。
  restart.sh 只用于直接启动的实例，遇到版本监督器会保留现有服务并提示正确停止方法。
  回退只恢复代码和必要的启动前配置，始终保留新增用量；不保证正在执行的请求可恢复。`;

try {
  if (!command || ["--help", "-h"].includes(command)) console.log(help);
  else if (command === "snapshot" && args.length === 3) {
    const manifest = await createReleaseSnapshot(...args);
    console.log(JSON.stringify({ releaseId: manifest.releaseId, version: manifest.version, files: manifest.files.length, contentHash: manifest.contentHash }));
  } else if (command === "verify" && args.length === 1) {
    const manifest = await verifyReleaseSnapshot(args[0]);
    console.log(JSON.stringify({ verified: true, releaseId: manifest.releaseId, contentHash: manifest.contentHash }));
  } else if (command === "run" && args.length >= 5 && args.length % 2 === 1) {
    const options = {};
    for (let index = 1; index < args.length; index += 2) {
      const key = args[index];
      if (!["--fallback", "--data-dir", "--port", "--host", "--startup-timeout-ms"].includes(key) || options[key] !== undefined) throw new Error(`未知或重复参数：${key}`);
      options[key] = args[index + 1];
    }
    if (!options["--data-dir"] || !options["--port"]) throw new Error("必须指定独立数据目录与端口");
    await runRelease({ candidate: args[0], fallback: options["--fallback"], dataDir: options["--data-dir"],
      port: Number(options["--port"]), host: options["--host"] || "127.0.0.1",
      startupTimeoutMs: Number(options["--startup-timeout-ms"] || 15000) });
  } else throw new Error(help);
} catch (error) {
  console.error(`版本工具失败：${error.message}`);
  process.exitCode = 1;
}
