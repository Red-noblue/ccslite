/**
 * 版本启动与回退监督器：只管理自己启动的子进程，候选失败时最多回退一次。
 * 代码包保持不变，配置独立保存；启动失败只恢复配置，不倒退或覆盖用量日志。
 */
import { spawn, spawnSync } from "node:child_process";
import { open, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { verifyReleaseSnapshot } from "./release-snapshot.js";
import { createRuntimeConfig, loadRuntimeEnvironment } from "./runtime-config.js";
import { acquireReleaseLock } from "./release-lock.js";
import { readBuildInfo } from "./build-info.js";
import { assertNoDataPathSymlinks } from "./data-path-guard.js";
import { checkReleaseHealth, createReleaseHealthMonitor } from "./release-health.js";

const FAILED_START_STOP_GRACE_MS = 3_000;

const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);

async function assertPortFree(host, port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error(`端口 ${host}:${port} 已占用，保持现有服务不动`)));
    server.listen(port, host, resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

export async function runRelease({ candidate, fallback, dataDir, port, host = "127.0.0.1", startupTimeoutMs = 15000, log = console.log }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须为 1～65535 的整数");
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 120000) throw new Error("启动等待时间必须为 100～120000 毫秒");
  const candidateRoot = await realpath(candidate);
  const fallbackRoot = fallback ? await realpath(fallback) : null;
  const releases = [candidateRoot, fallbackRoot].filter(Boolean);
  const manifests = await Promise.all(releases.map(verifyReleaseSnapshot));
  const builds = releases.map(readBuildInfo);
  if (fallbackRoot === candidateRoot) throw new Error("候选与回退必须是两个独立版本包");
  await assertPortFree(host, port);
  await mkdir(path.resolve(dataDir), { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(dataDir);
  if (releases.some((root) => inside(dataRoot, root) || inside(root, dataRoot))) throw new Error("业务数据目录必须与版本包完全分开");
  await assertNoDataPathSymlinks(dataRoot);
  const paths = {
    LITE_CCSWITCH_DATA_DIR: dataRoot,
    LITE_CCSWITCH_CONFIG: path.join(dataRoot, "config.json"),
    LITE_CCSWITCH_USAGE: path.join(dataRoot, "usage.jsonl"),
    LITE_CCSWITCH_PRICE_LAB: path.join(dataRoot, "price-lab.json"),
    LITE_CCSWITCH_413_LOG: path.join(dataRoot, "413-diagnostics.jsonl"),
    LITE_CCSWITCH_HOST: host,
    LITE_CCSWITCH_PORT: String(port),
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  for (const key of ["LITE_CCSWITCH_PROXY_TOKEN", "LITE_CCSWITCH_ADMIN_TOKEN"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, paths);
  const runtime = createRuntimeConfig({ dirname: candidateRoot, env: loadRuntimeEnvironment(candidateRoot, env) });
  if (!runtime.isLoopback && (!runtime.proxyToken || !runtime.adminToken)) throw new Error("非本机监听必须配置代理与管理令牌");
  const configBefore = await readFile(paths.LITE_CCSWITCH_CONFIG);
  const config = JSON.parse(configBefore);
  // 本阶段仅支持现有第 2 版配置，跨版本迁移必须另行审查与演练。
  if (config.version !== 2) throw new Error("版本启动器只接收 version=2 的既有配置，禁止自动迁移旧数据");
  for (const group of config.groups || []) {
    if (group.id !== "default" && group.listener?.enabled) await assertPortFree(group.listener.host, group.listener.port);
  }
  for (const root of releases) {
    const check = spawnSync(process.execPath, ["--check", path.join(root, "server.js")], { encoding: "utf8" });
    if (check.status !== 0) throw new Error(`版本语法检查失败：${root}`);
  }
  const lock = await acquireReleaseLock(dataRoot);
  try {
    const recoveryDir = path.join(dataRoot, "release-recovery");
    await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
    const operation = `${Date.now()}-${crypto.randomUUID()}`;
    await writeFile(path.join(recoveryDir, `${operation}.config.json`), configBefore, { flag: "wx", mode: 0o600 });
    const historyPath = path.join(recoveryDir, `${operation}.json`);
    const history = { operation, startedAt: new Date().toISOString(), port, events: [] };
    const record = async (event, details = {}) => {
      history.events.push({ event, timestamp: new Date().toISOString(), ...details });
      await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
      log(JSON.stringify(history.events.at(-1)));
    };
    let current = null;
    let stopping = false;
    let ready = false;
    const stopCurrent = () => {
      if (!current || current.stopSent || current.child.exitCode !== null || current.child.signalCode !== null) return;
      current.stopSent = true;
      current.child.kill("SIGTERM");
    };
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void current?.health?.stop();
      stopCurrent();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    const launch = async (root, manifest) => {
      const fd = await open(path.join(dataRoot, "release-process.log"), "a", 0o600);
      try {
        const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, env, detached: true, stdio: ["ignore", fd.fd, fd.fd, "ipc"] });
        const exit = new Promise((resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
          child.once("error", (error) => resolve({ code: 1, error: error.message }));
        });
        current = { child, exit, stopSent: false };
        await lock.track(child.pid);
        ready = false;
        await record("starting", { releaseId: manifest.releaseId, pid: child.pid });
        const deadline = Date.now() + startupTimeoutMs;
        while (Date.now() < deadline && !stopping && child.exitCode === null && child.signalCode === null) {
          try {
            const healthHost = host.includes(":") ? `[${host === "::" ? "::1" : host}]` : host === "0.0.0.0" ? "127.0.0.1" : host;
            const response = await fetch(`http://${healthHost}:${port}/api/status`, {
              headers: runtime.adminToken ? { "x-lite-ccswitch-token": runtime.adminToken } : {}, signal: AbortSignal.timeout(400),
            });
            if (response.ok) {
              const status = await response.json();
              if (status.processId !== child.pid) throw new Error("监听端口属于其他进程");
              if (status.port === port && status.persistence?.configPath === paths.LITE_CCSWITCH_CONFIG &&
                  status.persistence?.usagePath === paths.LITE_CCSWITCH_USAGE &&
                  (!status.build || status.build.releaseId === manifest.releaseId) &&
                  status.groups?.length && status.groups.every((group) => !group.listener.enabled ||
                    group.listenerStatus === "listening" && group.actualListener?.port === group.listener.port)) {
                ready = true;
                await record("ready", { releaseId: manifest.releaseId, pid: child.pid });
                return;
              }
            }
          } catch { /* 等待进程完成启动；健康校验失败不能宣告发布成功。 */ }
          await delay(50);
        }
        throw new Error(stopping ? "启动已取消" : "版本未通过启动健康检查");
      } finally { await fd.close(); }
    };

    try {
      for (let index = 0; index < releases.length; index += 1) {
        try {
          await launch(releases[index], manifests[index]);
          const expected = { pid: current.child.pid, port, build: builds[index],
            configPath: paths.LITE_CCSWITCH_CONFIG, usagePath: paths.LITE_CCSWITCH_USAGE };
          const healthHost = host.includes(":") ? `[${host === "::" ? "::1" : host}]` : host === "0.0.0.0" ? "127.0.0.1" : host;
          if (!stopping) current.health = createReleaseHealthMonitor({
            check: (signal) => checkReleaseHealth({ url: `http://${healthHost}:${port}/api/status`, token: runtime.adminToken, expected, signal }),
            onEvent: ({ event, ...details }) => record(event, { releaseId: manifests[index].releaseId, pid: expected.pid, ...details }),
          });
          const result = await current.exit;
          await current.health?.stop();
          if (stopping) { await record("stopped", { releaseId: manifests[index].releaseId }); return; }
          throw new Error(`版本意外退出：${result.code ?? result.signal}`);
        } catch (error) {
          // 先等观察日志结束，再写退出与回退记录，避免并发写同一份操作历史。
          await current?.health?.stop();
          stopCurrent();
          if (current && !ready && !stopping) {
            let timer;
            const ended = await Promise.race([
              current.exit.then(() => true),
              new Promise((resolve) => { timer = setTimeout(() => resolve(false), FAILED_START_STOP_GRACE_MS); }),
            ]);
            clearTimeout(timer);
            if (!ended && !stopping) {
              await record("startup_force_stop", { releaseId: manifests[index].releaseId, pid: current.child.pid });
              current.child.kill("SIGKILL");
            }
          }
          if (current) await current.exit;
          if (stopping) { await record("stopped"); return; }
          await record("failed", { releaseId: manifests[index].releaseId, message: error.message });
          if (index + 1 === releases.length) throw new Error(`版本未能恢复服务，请查看 ${path.join(dataRoot, "release-process.log")}`);
          // 仅启动失败时恢复启动前配置；已就绪版本的后续变更保留，始终保留新增用量。
          if (!ready) {
            const temporary = path.join(dataRoot, `config.${operation}.tmp`);
            await writeFile(temporary, configBefore, { flag: "wx", mode: 0o600 });
            await rename(temporary, paths.LITE_CCSWITCH_CONFIG);
          }
          await record("rollback", { releaseId: manifests[index + 1].releaseId, configRestored: !ready });
        }
      }
    } finally {
      process.off("SIGTERM", shutdown);
      process.off("SIGINT", shutdown);
    }
  } finally {
    await lock.release();
  }
}
