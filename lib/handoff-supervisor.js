/**
 * 中文固定监听监督器：公开端口由交接层持有，版本子进程只使用私有端口。
 * 候选先只读预热；旧版本排空后才激活候选，观察期内保留旧版本用于快速回退。
 * 候选可以是带清单的冻结版本包，也可以是根目录源码；源码模式的数据目录固定为根目录 data/。
 */
import { requestIpc } from "./handoff-rpc.js";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createServer } from "node:net";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyReleaseSnapshot } from "./release-snapshot.js";
import { createHandoffListener } from "./handoff-listener.js";
import { createHandoffCoordinator } from "./handoff-coordinator.js";
import { createWriteLease } from "./write-lease.js";
import { acquireReleaseLock } from "./release-lock.js";
import { readBuildInfo } from "./build-info.js";
import { checkReleaseHealth, createReleaseHealthMonitor } from "./release-health.js";
import { createRuntimeConfig, loadRuntimeEnvironment } from "./runtime-config.js";
import { createHandoffJournal } from "./handoff-journal.js";
import { createHandoffPersistence } from "./handoff-persistence.js";
import { assertNoDataPathSymlinks } from "./data-path-guard.js";
import { setTimeout as delay } from "node:timers/promises";

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}

async function readConfig(dataDir) { return JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")); }

export async function createHandoffSupervisor({ candidate, fallback = null, dataDir, publicPort,
  host = "127.0.0.1", log: externalLog = console.log, observeMs = 30_000, leasePolicy = {}, healthPolicy = {}, controlTimeoutMs = 35_000,
  workspaceCandidate = false } = {}) {
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) throw new Error("端口必须为 1～65535 的整数");
  const candidateRoot = await realpath(candidate); const fallbackRoot = fallback ? await realpath(fallback) : null;
  if (!workspaceCandidate) await verifyReleaseSnapshot(candidateRoot);
  await Promise.all([...(fallbackRoot ? [verifyReleaseSnapshot(fallbackRoot)] : [])]);
  if (fallbackRoot === candidateRoot) throw new Error("候选与回退必须是两个独立版本包");
  const resolvedDataDir = await realpath(dataDir);
  const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
  const validateDataIsolation = async (root) => {
    if (inside(root, resolvedDataDir) || inside(resolvedDataDir, root)) throw new Error("业务数据目录必须与版本包完全分开");
    await assertNoDataPathSymlinks(resolvedDataDir);
  };
  if (workspaceCandidate && (resolvedDataDir === candidateRoot || resolvedDataDir.startsWith(`${candidateRoot}${path.sep}`))) {
    const expectedDataDir = path.join(candidateRoot, "data");
    if (resolvedDataDir !== expectedDataDir) throw new Error("源码模式的数据目录必须是源码根目录下的 data");
    await assertNoDataPathSymlinks(resolvedDataDir);
    if (fallbackRoot) await validateDataIsolation(fallbackRoot);
  } else {
    for (const root of [candidateRoot, fallbackRoot].filter(Boolean)) await validateDataIsolation(root);
  }
  let ownershipLock = null;
  const journal = createHandoffJournal({
    directory: resolvedDataDir,
    supervisorPid: process.pid,
    onError: (error) => {
      try { externalLog(`交接事件日志写入失败：${error.message}`); } catch { /* 终端日志异常不能中断交接。 */ }
    },
  });
  const persistence = createHandoffPersistence({
    dataDir: resolvedDataDir,
    usagePath: path.join(resolvedDataDir, "usage.jsonl"),
    configPath: path.join(resolvedDataDir, "config.json"),
    diagnosticPath: path.join(resolvedDataDir, "413-diagnostics.jsonl"),
    onEvent: (event) => log(JSON.stringify(event)),
  });
  const log = (line) => {
    let details; try { details = JSON.parse(line); } catch { details = { message: String(line) }; }
    // 常规转发完成事件不刷终端，由日志模块按时间和数量聚合为汇总事件。
    if (details.event !== "handoff_request_finished") {
      try { externalLog(line); } catch { /* 终端日志异常不能中断交接收尾。 */ }
    }
    if (!ownershipLock) return;
    journal.record(details);
  };
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_") || ["LITE_CCSWITCH_PROXY_TOKEN", "LITE_CCSWITCH_ADMIN_TOKEN"].includes(key)));
  const environment = loadRuntimeEnvironment(candidateRoot, { ...inherited,
    LITE_CCSWITCH_DATA_DIR: resolvedDataDir, LITE_CCSWITCH_CONFIG: path.join(resolvedDataDir, "config.json"),
    LITE_CCSWITCH_USAGE: path.join(resolvedDataDir, "usage.jsonl"), LITE_CCSWITCH_PRICE_LAB: path.join(resolvedDataDir, "price-lab.json"),
    LITE_CCSWITCH_413_LOG: path.join(resolvedDataDir, "413-diagnostics.jsonl"), LITE_CCSWITCH_HOST: host, LITE_CCSWITCH_PORT: String(publicPort) });
  delete environment.LITE_CCSWITCH_ENV_FILE;
  delete environment.LITE_CCSWITCH_SKIP_BOOTSTRAP;
  const runtime = createRuntimeConfig({ dirname: candidateRoot, env: environment });
  const config = await readConfig(resolvedDataDir);
  const configuredGroups = (value) => (value.groups || []).map((group) => ({
    id: group.id, host: group.listener.host || host, port: Number(group.listener.port), enabled: group.listener.enabled !== false,
  }));
  let groups = configuredGroups(config);
  const defaultGroup = groups.find((group) => group.id === "default");
  if (!defaultGroup || defaultGroup.port !== publicPort) throw new Error("配置默认分组端口与交接主端口不一致");
  const listener = createHandoffListener({ host, mainPort: publicPort, groups: groups.filter((group) => group.id !== "default"),
    proxyToken: runtime.proxyToken, adminToken: runtime.adminToken,
    getRuntimeState: () => ({ ...coordinator?.state(), leaseFault: leaseFault?.message || null, health: healthObservation && { ...healthObservation },
      journal: journal.state(), persistence: persistence.state(), session: listener?.sessionState?.(), groupChange: groupChange ? { groupId: groupChange.group.id, transaction: groupChange.transaction } : null }),
    onEvent: (event) => log(JSON.stringify(event)) });
  const writeLease = createWriteLease({ directory: path.join(resolvedDataDir, "handoff-write-lease"), archiveDirectory: path.join(resolvedDataDir, "release-recovery"), ttlMs: leasePolicy.ttlMs || 30_000 });
  const leaseStatePath = path.join(resolvedDataDir, "handoff-active-worker.json");
  const workers = new Set();
  let current = null; let leaseWorker = null; let leaseRenewTimer = null; let closing = false; let coordinator = null;
  let healthMonitor = null; let healthObservation = null;
  let leaseFault = null; let leaseTasks = Promise.resolve(); let closePromise = null;
  let groupChange = null; let groupTasks = Promise.resolve(); let operation = null; let operationTask = null; let bootTask = null;
  const rollbackRoot = fallbackRoot;
  let automaticRecoveries = 0; let recoveryError = null;
  let forceClosing = false;
  const serializeLease = (task) => { const next = leaseTasks.catch(() => {}).then(task); leaseTasks = next; return next; };
  const writeLeaseState = async (state, worker = leaseWorker) => {
    const temporary = `${leaseStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ state, workerId: worker?.id || null, workerPid: worker?.pid || null, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await rename(temporary, leaseStatePath);
  };
  const renewLease = async () => {
    if (!ownershipLock) return;
    try {
      await serializeLease(async () => {
        if (writeLease.isHeld()) await writeLease.renew(); else await writeLease.acquire();
        await writeLeaseState(leaseWorker ? "active" : "transferring");
      });
      if (leaseFault) {
        leaseFault = null;
        if (!closing && !groupChange && !operation && ["active", "active_parallel"].includes(coordinator.state().phase) && listener.queue.state() === "draining") listener.resumeRequests();
        if (!closing && !groupChange && !operation && ["active", "active_parallel"].includes(coordinator.state().phase)) listener.resumeAdminWrites();
        log(JSON.stringify({ event: "handoff_lease_recovered", worker: current?.id || null }));
      }
    } catch (error) {
      if (!leaseFault) {
        leaseFault = error;
        if (!closing && listener.queue.state() === "open") listener.beginDrain();
        log(JSON.stringify({ event: "handoff_lease_degraded", action: "queue_new_requests", message: error.message }));
      }
    }
  };
  const startLeaseRenewal = () => {
    clearInterval(leaseRenewTimer);
    leaseRenewTimer = setInterval(() => { void renewLease(); }, leasePolicy.renewIntervalMs || 10_000);
    leaseRenewTimer.unref?.();
  };
  const releaseWorkerLease = (worker) => serializeLease(async () => {
    if (!writeLease.isHeld() || (leaseWorker && leaseWorker.pid !== worker.pid)) throw new Error("当前工作进程没有写入租约");
    await persistence.pauseConfigWrites();
    await writeLease.renew(); leaseWorker = null; persistence.setActiveWorker("__transferring__"); await writeLeaseState("transferring", worker);
  });
  const acquireWorkerLease = (worker) => serializeLease(async () => {
    if (!writeLease.isHeld()) await writeLease.acquire();
    await writeLease.renew(); leaseWorker = worker; persistence.setActiveWorker(worker.generation); await writeLeaseState("active", worker);
  });

  const createWorker = async (root, manifest, readOnly) => {
    const build = readBuildInfo(root);
    const mainPort = await reservePort(); const groupPorts = {};
    for (const group of groups) if (group.id !== "default" && group.enabled) groupPorts[group.id] = await reservePort();
    const generation = `${manifest.releaseId}:${crypto.randomUUID()}`;
    const env = { ...environment };
    Object.assign(env, {
      LITE_CCSWITCH_DATA_DIR: resolvedDataDir, LITE_CCSWITCH_CONFIG: path.join(resolvedDataDir, "config.json"),
      LITE_CCSWITCH_USAGE: path.join(resolvedDataDir, "usage.jsonl"), LITE_CCSWITCH_HOST: "127.0.0.1",
      LITE_CCSWITCH_PORT: String(mainPort), LITE_CCSWITCH_PUBLIC_PORT: String(publicPort), LITE_CCSWITCH_HANDOFF_WORKER: "1",
      LITE_CCSWITCH_HANDOFF_WORKER_ID: generation,
      LITE_CCSWITCH_HANDOFF_READ_ONLY: readOnly ? "1" : "0", LITE_CCSWITCH_HANDOFF_GROUP_PORTS: JSON.stringify(groupPorts),
      LITE_CCSWITCH_PROXY_TOKEN: runtime.proxyToken, LITE_CCSWITCH_ADMIN_TOKEN: runtime.adminToken,
      LITE_CCSWITCH_PUBLIC_HOST: host,
    });
    let stdout = ""; let stderr = "";
    const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-65536); }); child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-65536); });
    const exit = new Promise((resolve, reject) => { child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
    const worker = { id: manifest.releaseId, generation, build, root, pid: child.pid, child, exit, mainPort, groups: groupPorts, expectedReadOnly: readOnly,
      stdout: () => stdout, stderr: () => stderr, stopSent: false };
    workers.add(worker);
    void exit.then(() => workers.delete(worker), () => workers.delete(worker));
    child.on("message", (message) => {
      if (["handoff_persist_usage", "handoff_persist_config", "handoff_persist_diagnostic", "handoff_session_checkpoint", "handoff_response_contexts", "handoff_read_config"].includes(message?.type)) {
        const reply = (value) => { if (child.connected) child.send({ type: "handoff_control_result", requestId: message.requestId, ...value }, () => {}); };
        const task = (async () => {
          if (message.type === "handoff_persist_usage") return persistence.appendUsage(message.record, { workerId: worker.generation, dedupeKey: message.dedupeKey });
          if (message.type === "handoff_persist_config") return persistence.saveConfig(message.config, { workerId: worker.generation, baseRevision: message.baseRevision ?? null, operationId: message.operationId || null });
          if (message.type === "handoff_persist_diagnostic") return persistence.appendDiagnostic(message.record, { workerId: worker.generation });
          if (message.type === "handoff_read_config") return persistence.readConfig();
          if (message.type === "handoff_response_contexts") return listener.updateResponseContexts({ ...message, workerId: worker.id, workerPid: worker.pid });
          return listener.checkpoint({ ...message, requestId: message.checkpointRequestId, workerId: worker.id, workerPid: worker.pid });
        })();
        task.then((result) => reply({ result }), (error) => reply({ error: { message: error.message, code: error.code, status: error.status || 500 } }));
        return;
      }
      if (!["handoff_group_prepare", "handoff_group_commit", "handoff_group_abort"].includes(message?.type)) return;
      const task = groupTasks.catch(() => {}).then(() => handleGroupChange(worker, message)); groupTasks = task;
      const reply = (value) => { if (child.connected) child.send({ type: "handoff_control_result", requestId: message.requestId, ...value }, () => {}); };
      task.then((result) => reply({ result }), (error) => reply({ error: { message: error.message, code: error.code, status: error.status || 500 } }));
    });
    try { await ownershipLock.track(child.pid); }
    catch (error) { child.kill("SIGTERM"); await exit; throw error; }
    return worker;
  };
  const status = async (worker) => {
    const response = await fetch(`http://127.0.0.1:${worker.mainPort}/api/status`, {
      headers: runtime.adminToken ? { "x-lite-ccswitch-token": runtime.adminToken } : {}, signal: AbortSignal.timeout(500) });
    if (!response.ok) throw new Error(`工作进程状态接口返回 HTTP ${response.status}`); return response.json();
  };
  const checkWorker = async (worker, readOnly) => {
    const state = await status(worker);
    if (state.processId !== worker.pid || state.port !== worker.mainPort || ["version", "releaseId", "codeHash"].some((key) => state.build?.[key] !== worker.build[key]) || state.handoff?.readOnly !== readOnly)
      throw new Error(`工作进程 ${worker.id} 身份或只读状态不匹配`);
    if (state.persistence?.configPath !== path.join(resolvedDataDir, "config.json") || state.persistence?.usagePath !== path.join(resolvedDataDir, "usage.jsonl"))
      throw new Error(`工作进程 ${worker.id} 数据路径不匹配`);
    const privateGroups = {};
    for (const group of groups.filter((item) => item.enabled)) {
      const item = state.groups.find((entry) => entry.id === group.id);
      const actual = group.id === "default" ? worker.mainPort : item?.actualListener?.port;
      if (!item || item.listenerStatus !== "listening" || item.actualListener?.host !== "127.0.0.1" || !Number.isInteger(actual) || item.actualListener?.port !== actual)
        throw new Error(`工作进程 ${worker.id} 分组 ${group.id} 未监听私有端口`);
      if (group.id !== "default") privateGroups[group.id] = actual;
    }
    worker.groups = privateGroups;
    return state;
  };
  const waitReady = async (worker, readOnly) => {
    const deadline = Date.now() + 15_000; let lastError;
    while (Date.now() < deadline) {
      if (worker.child.exitCode !== null) throw new Error(`工作进程提前退出：${worker.stderr()}`);
      try { return await checkWorker(worker, readOnly); } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    throw new Error(`工作进程未就绪：${lastError?.message || "未知错误"}`);
  };
  const send = (worker, message, expected) => requestIpc(worker.child, message.type, message, {
    replyType: expected, raw: true, timeoutMs: controlTimeoutMs,
  });
  const stopWorker = async (worker, forceAfterMs = 0) => {
    if (!worker || worker.child.exitCode !== null || worker.child.signalCode !== null) return worker?.exit;
    if (!worker.stopSent) { worker.stopSent = true; worker.child.kill("SIGTERM"); }
    if (!forceAfterMs) return worker.exit;
    const timer = setTimeout(() => worker.child.kill("SIGKILL"), forceAfterMs);
    try { return await worker.exit; } finally { clearTimeout(timer); }
  };
  const activeRequests = async () => {
    if (!current) return 0;
    const forwarding = listener.queue.stats().inFlight;
    try { const state = await status(current); return Math.max(forwarding, listener.queue.stats().inFlight, Number(state.activeRequests?.active || 0), Number(state.handoff?.pendingRequests || 0)); } catch { return Number.POSITIVE_INFINITY; }
  };
  const waitForShutdownIdle = async () => {
    // 停止前保持公开监听和当前工作进程，让新请求继续完成，避免队列被关闭后返回 handoff_closed。
    while (!forceClosing) {
      if (!current || current.child.exitCode !== null || current.child.signalCode !== null) return;
      if (listener.queue.stats().queuedRequests === 0 && await activeRequests() === 0) return;
      await delay(25);
    }
  };
  const startCandidate = async (spec, options) => {
    if (closing) throw new Error("监督器正在停止");
    groups = configuredGroups(await readConfig(resolvedDataDir));
    if (!(workspaceCandidate && spec.workspace)) await validateDataIsolation(spec.root);
    const manifest = spec.workspace ? readBuildInfo(spec.root) : await verifyReleaseSnapshot(spec.root);
    const worker = await createWorker(spec.root, manifest, options.readOnly);
    try { await waitReady(worker, options.readOnly); if (closing) throw new Error("监督器正在停止"); return worker; }
    catch (error) { await stopWorker(worker, 3000).catch((cleanup) => log(`候选进程清理失败：${cleanup.message}`)); throw error; }
  };
  const checkCandidate = async (worker, options) => { await checkWorker(worker, options.readOnly); };
  const preparePrevious = async (worker) => { await listener.pauseAdminWrites(); await send(worker, { type: "handoff_prepare_readonly" }, "handoff_readonly"); };
  const prepareContinuation = async (worker) => { await listener.pauseAdminWrites(); await send(worker, { type: "handoff_prepare_continuation" }, "handoff_continuation"); };
  const activateWorker = async (worker) => { groups = configuredGroups(await readConfig(resolvedDataDir)); await send(worker, { type: "handoff_activate" }, "handoff_activated"); await checkWorker(worker, false); };
  const dispatch = (worker, request) => listener.dispatch(worker, request);
  const onSessionActivated = async (worker, oldWorker) => {
    await activateWorker(worker);
    for (const previous of listener.groups()) if (!groups.some((group) => group.id === previous.id)) await listener.forgetGroup(previous.id);
    for (const group of groups) await listener.applyGroup({ id: group.id, listener: { host: group.host, port: group.port, enabled: group.enabled } });
    listener.beginSessionHandoff(oldWorker, worker);
    current = worker;
  };
  const onActivated = async (worker) => {
    await activateWorker(worker);
    for (const previous of listener.groups()) if (!groups.some((group) => group.id === previous.id)) await listener.forgetGroup(previous.id);
    for (const group of groups) await listener.applyGroup({ id: group.id, listener: { host: group.host, port: group.port, enabled: group.enabled } });
    groupChange = null; listener.activate(worker); current = worker;
  };
  coordinator = createHandoffCoordinator({ queue: listener.queue, startCandidate, checkCandidate, stopCandidate: stopWorker,
    preparePrevious, prepareContinuation, onActivated, onSessionActivated, onPreviousRetired: async (worker) => listener.retireWorker(worker), canRetirePrevious: async (worker) => listener.canRetireWorker(worker), acquireWriteLease: acquireWorkerLease, releaseWriteLease: releaseWorkerLease, dispatch, getActiveRequests: () => activeRequests(),
    onEvent: (event) => {
      if (event.phase === "failed") listener.adminQueue.close(Object.assign(new Error(event.message || "版本交接失败"), { status: 503, code: "handoff_failed" }));
      log(JSON.stringify(event));
    } });

  const handleGroupChange = async (worker, message) => {
    const conflict = (text) => Object.assign(new Error(text), { status: 409 });
    if (message.type === "handoff_group_prepare") {
      if (closing || operation || groupChange || leaseFault || current !== worker || !["active", "active_parallel"].includes(coordinator.state().phase)) throw conflict("版本正在交接或分组操作尚未完成，请稍后重试");
      const group = structuredClone(message.group);
      if (!group?.id || group.id === "default" || !group.listener) throw conflict("默认分组的公开端口由启动入口固定");
      const pending = { transaction: crypto.randomUUID(), group, previous: listener.group(group.id), worker };
      groupChange = pending;
      try {
        await renewLease(); if (leaseFault) throw leaseFault;
        listener.beginDrain();
        for (let attempt = 0; ; attempt += 1) {
          try { await listener.applyGroup(group); break; }
          catch (error) {
            if (!message.autoAllocate || error.code !== "EADDRINUSE" || attempt >= 100 || group.listener.port >= 65535) throw error;
            group.listener.port += 1;
          }
        }
        log(JSON.stringify({ event: "handoff_group_prepared", groupId: group.id, transaction: pending.transaction }));
        return { transaction: pending.transaction, listener: group.listener };
      } catch (error) {
        groupChange = null;
        if (!closing && !leaseFault && listener.queue.state() === "draining") listener.resumeRequests();
        throw error;
      }
    }
    const pending = groupChange;
    if (!pending || pending.worker !== worker || message.transaction !== pending.transaction) throw conflict("分组操作的确认标识已经失效");
    if (message.type === "handoff_group_commit") {
      const saved = await readConfig(resolvedDataDir); const savedGroup = saved.groups.find((group) => group.id === pending.group.id);
      if (!savedGroup || JSON.stringify(savedGroup.listener) !== JSON.stringify(pending.group.listener)) throw new Error("分组配置尚未按预留端口保存，保留交接队列");
      log(JSON.stringify({ event: "handoff_group_commit_started", groupId: savedGroup.id, transaction: pending.transaction }));
      const state = await status(worker); const actual = state.groups.find((group) => group.id === savedGroup.id)?.actualListener;
      if (savedGroup.listener.enabled && (!actual || actual.host !== "127.0.0.1" || actual.port !== message.privatePort || actual.port === savedGroup.listener.port)) throw new Error("分组私有监听尚未就绪，保留交接队列");
      if (actual) worker.groups[savedGroup.id] = actual.port; else delete worker.groups[savedGroup.id];
      groups = configuredGroups(saved);
      log(JSON.stringify({ event: "handoff_group_committed", groupId: savedGroup.id, transaction: pending.transaction }));
    } else {
      const previous = pending.previous || { id: pending.group.id, ...pending.group.listener, enabled: false };
      await listener.applyGroup({ id: previous.id, listener: { host: previous.host, port: previous.port, enabled: previous.enabled } });
      if (!pending.previous) await listener.forgetGroup(pending.group.id);
      log(JSON.stringify({ event: "handoff_group_aborted", groupId: pending.group.id, transaction: pending.transaction }));
    }
    groupChange = null;
    if (!closing && !leaseFault) listener.resumeRequests();
    return { ok: true };
  };

  const stopHealth = async () => {
    const monitor = healthMonitor; healthMonitor = null;
    await monitor?.stop();
  };
  const startHealth = async (worker) => {
    await stopHealth();
    if (closing || current !== worker) return;
    const observation = { worker: worker.id, pid: worker.pid, healthySince: null, consecutiveSuccesses: 0, lastCheckedAt: null, lastError: null };
    healthObservation = observation;
    healthMonitor = createReleaseHealthMonitor({
      ...healthPolicy,
      onEvent: (event) => log(JSON.stringify({ ...event, releaseId: worker.id, pid: worker.pid })),
      onError: (error) => log(`健康观察记录失败：${error.message}`),
      check: async (signal) => {
        try {
          await checkReleaseHealth({ url: `http://127.0.0.1:${worker.mainPort}/api/status`, token: runtime.adminToken,
            expected: { pid: worker.pid, port: worker.mainPort, build: worker.build,
              configPath: path.join(resolvedDataDir, "config.json"), usagePath: path.join(resolvedDataDir, "usage.jsonl") },
            signal, timeoutMs: healthPolicy.timeoutMs });
          if (signal.aborted || closing || current !== worker) return;
          if (leaseFault) throw new Error("写入租约尚未恢复，保留旧版本");
          observation.lastCheckedAt = Date.now(); observation.lastError = null;
          observation.healthySince ??= Date.now(); observation.consecutiveSuccesses += 1;
          // 观察必须连续健康且至少检查三次；异常只告警，不能到点就丢弃回退进程。
          if (!groupChange && !operation && observation.consecutiveSuccesses >= 3 && Date.now() - observation.healthySince >= observeMs) {
            if (automaticRecoveries) { automaticRecoveries = 0; recoveryError = null; log(JSON.stringify({ event: "handoff_recovery_confirmed", worker: worker.id })); }
            await coordinator.retirePrevious();
          }
        } catch (error) {
          if (!signal.aborted) {
            observation.healthySince = null; observation.consecutiveSuccesses = 0;
            observation.lastCheckedAt = Date.now(); observation.lastError = error.message;
          }
          throw error;
        }
      },
    });
  };
  const finishOperation = () => {
    operation = null; operationTask = null;
    if (!closing && !leaseFault && ["active", "active_parallel"].includes(coordinator.state().phase)) listener.resumeAdminWrites();
    recoverExited();
  };
  const rollback = async (reason, workerExited = false) => {
    if (closing || operation || (groupChange && !workerExited)) throw Object.assign(new Error("版本或分组交接正在进行，或监督器正在停止"), { status: 409 });
    if (!rollbackRoot) throw Object.assign(new Error("没有配置固定回退包"), { status: 409 });
    if (!workerExited && current.root === rollbackRoot) return current;
    operation = "rollback";
    operationTask = (async () => {
      await groupTasks.catch(() => {}); await stopHealth();
      await listener.pauseAdminWrites();
      // 回退目标始终是指定备份，不能被升级前进程或其源码目录替换。
      const spec = { id: path.basename(rollbackRoot), root: rollbackRoot };
      const worker = await coordinator.recover(spec, reason, { prepareCurrent: !workerExited });
      if (!workerExited) { automaticRecoveries = 0; recoveryError = null; }
      attachExit(worker); await startHealth(worker); return worker;
    })();
    try { return await operationTask; }
    catch (error) { await startHealth(current); throw error; }
    finally { finishOperation(); }
  };
  const recoverExited = () => {
    if (closing || operation || !current || !["active", "active_parallel"].includes(coordinator.state().phase)) return;
    if (current.child.exitCode === null && current.child.signalCode === null) return;
    if (automaticRecoveries >= 1) {
      recoveryError = "回退进程尚未通过连续健康观察便再次退出，停止自动重试，请检查日志并手动恢复";
      coordinator.fail(Object.assign(new Error(recoveryError), { code: "handoff_recovery_exhausted", status: 503 }));
      void stopHealth(); log(JSON.stringify({ event: "handoff_recovery_exhausted", worker: current.id, pid: current.pid, message: recoveryError })); return;
    }
    automaticRecoveries += 1;
    listener.beginDrain();
    void rollback(`工作进程退出：${current.child.exitCode ?? current.child.signalCode}`, true).catch((error) => log(`回退失败：${error.message}`));
  };
  const attachExit = (worker) => {
    if (worker.exitAttached) return;
    worker.exitAttached = true;
    void worker.exit.then(() => { if (current === worker) recoverExited(); }, (error) => log(`工作进程异常：${error.message}`));
  };
  const boot = async () => {
    // 与现有版本入口共用锁；原监督器已退出但子进程仍排空时，拒绝抢占数据目录。
    ownershipLock = await acquireReleaseLock(resolvedDataDir);
    await writeLease.acquire();
    // 监督器崩溃期间由工作进程写入的专属暂存记录，在取得租约后统一合并。
    await persistence.recoverPendingUsage();
    startLeaseRenewal(); await listener.listen();
    let worker;
    for (const spec of [{ root: candidateRoot, workspace: workspaceCandidate }, ...(fallbackRoot ? [{ root: fallbackRoot, workspace: false }] : [])]) {
      try {
        worker = await startCandidate(spec, { readOnly: true });
        await acquireWorkerLease(worker); await activateWorker(worker);
        if (closing) throw new Error("监督器正在停止");
        break;
      } catch (error) {
        if (worker) { await stopWorker(worker); if (leaseWorker === worker) await releaseWorkerLease(worker); worker = null; }
        if (closing || spec.root === (fallbackRoot || candidateRoot)) throw error;
        log(`候选版本启动或激活失败，尝试回退：${error.message}`);
      }
    }
    listener.activate(worker); current = worker; coordinator.setCurrent(worker); attachExit(worker);
    await startHealth(worker);
    return worker;
  };
  return {
    listener, coordinator,
    async start() {
      if (bootTask || closing) throw new Error("监督器已经启动或停止");
      bootTask = boot();
      try { return await bootTask; } catch (error) { await this.close().catch(() => {}); throw error; }
    },
    async upgrade(root) {
      if (leaseFault || closing || groupChange || operation || workers.size > 1) throw Object.assign(new Error("写入租约异常、交接正在进行或监督器正在停止，不能升级"), { status: 409 });
      operation = "upgrade";
      operationTask = (async () => {
        const resolved = await realpath(root); const manifest = await verifyReleaseSnapshot(resolved); await validateDataIsolation(resolved);
        await stopHealth();
        const worker = await coordinator.upgrade({ id: manifest.releaseId, root: resolved });
        automaticRecoveries = 0; recoveryError = null; attachExit(worker);
        await startHealth(worker); return worker;
      })();
      try { return await operationTask; }
      catch (error) { await startHealth(current); throw error; }
      finally { finishOperation(); }
    },
    async upgradeSession(root) {
      if (leaseFault || closing || groupChange || operation || workers.size > 1) throw Object.assign(new Error("写入租约异常、交接正在进行或监督器正在停止，不能进行会话交接"), { status: 409 });
      operation = "session_upgrade";
      operationTask = (async () => {
        const resolved = await realpath(root); const manifest = await verifyReleaseSnapshot(resolved); await validateDataIsolation(resolved);
        await stopHealth();
        const worker = await coordinator.upgradeSession({ id: manifest.releaseId, root: resolved });
        automaticRecoveries = 0; recoveryError = null; attachExit(worker);
        await startHealth(worker); return worker;
      })();
      try { return await operationTask; }
      catch (error) { await startHealth(current); throw error; }
      finally { finishOperation(); }
    },
    rollback,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
      closing = true; await bootTask?.catch(() => {}); await operationTask?.catch(() => {});
      await groupTasks.catch(() => {}); await waitForShutdownIdle(); coordinator.close(); await stopHealth();
      await listener.close();
      await Promise.all([...workers].map((worker) => stopWorker(worker)));
      clearInterval(leaseRenewTimer); leaseRenewTimer = null;
      await leaseTasks.catch(() => {});
      await persistence.flush();
      await journal.close();
      if (ownershipLock) {
        await writeFile(path.join(resolvedDataDir, "handoff-last-close.json"), JSON.stringify({ closedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
        try { await writeLease.release(); } finally { await ownershipLock.release(); ownershipLock = null; }
      }
      })();
      return closePromise;
    },
    forceClose() {
      forceClosing = true;
      listener.forceClose();
      for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    },
    current: () => current,
    state: () => ({ ...coordinator.state(), operation, leaseFault: leaseFault?.message || null, health: healthObservation && { ...healthObservation },
      worker: current ? { releaseId: current.id, pid: current.pid, root: current.root } : null, rollbackRoot, liveWorkers: workers.size,
      journal: journal.state(), journalError: journal.state().journalError, persistence: persistence.state(),
      session: listener.sessionState?.(), automaticRecoveries, recoveryError }),
  };
}
