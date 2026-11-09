/**
 * 中文写入所有权演练：重复启动不抢数据，续租异常先排队，监督器退出后仍保护旧工作进程排空。
 * 只使用独立临时数据、真实 Lite 工作进程和本机假上游，不连接正式服务或付费供应商。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error("等待写入所有权状态超时");
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; assert.ok(port >= 15725); return port;
}
const post = (port, input) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input, stream: input === "hold" }),
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("固定监听的写入隔离与租约故障恢复", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "release"); await createReleaseSnapshot(ROOT, candidate, "ownership-test");

  async function fixture(name, context) {
    const data = path.join(root, name); await mkdir(data);
    let calls = 0; let release = () => {};
    const upstream = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls += 1;
      if (body.input === "hold") {
        const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(event("response.output_text.delta", { delta: "开始" }));
        const timer = setInterval(() => res.write(event("response.output_text.delta", { delta: "继续" })), 50);
        res.once("close", () => clearInterval(timer));
        release = () => { clearInterval(timer); if (!res.destroyed) res.end(event("response.completed", { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })); };
      } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "completed", usage: { input_tokens: 1, output_tokens: 1 } })); }
    });
    const upstreamPort = await listen(upstream); const guard = createServer(); const publicPort = await listen(guard);
    await new Promise((resolve) => guard.close(resolve));
    await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
      providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
      groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }],
      connectivityTest: { periodicIntervalMs: null } }));
    await writeFile(path.join(data, "usage.jsonl"), "");
    context.after(async () => { release(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
    return { data, publicPort, release: () => release(), calls: () => calls,
      options: { candidate, dataDir: data, publicPort, log: () => {} },
      records: async () => (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse) };
  }

  await t.test("重复启动被拒绝且不写入当前实例的数据", async (context) => {
    const f = await fixture("duplicate", context);
    const first = await createHandoffSupervisor(f.options);
    context.after(() => first.close()); await first.start();
    const paths = ["config.json", "usage.jsonl", "handoff-active-worker.json", "handoff-write-lease/owner.json", "release-runner.lock"];
    const before = await Promise.all(paths.map((name) => readFile(path.join(f.data, name), "utf8")));
    const second = await createHandoffSupervisor(f.options);
    await assert.rejects(second.start(), /已有版本监督器/);
    const after = await Promise.all(paths.map((name) => readFile(path.join(f.data, name), "utf8")));
    assert.deepEqual(after, before, "启动被拒绝的实例不得改动租约、配置、用量和进程登记");
    await assert.rejects(readFile(path.join(f.data, "handoff-last-close.json")), { code: "ENOENT" });
    const response = await post(f.publicPort, "still-serving"); assert.equal(response.status, 200); await response.text();
    await until(async () => (await f.records()).length === 1);
    assert.equal(f.calls(), 1);
  });

  await t.test("续租异常暂停新请求并保留已有 SSE，修复后仅发送一次", async (context) => {
    const f = await fixture("renewal", context); const events = [];
    const supervisor = await createHandoffSupervisor({ ...f.options, leasePolicy: { ttlMs: 1000, renewIntervalMs: 50 }, log: (line) => events.push(line) });
    context.after(async () => { f.release(); await supervisor.close(); }); await supervisor.start();
    const stream = await post(f.publicPort, "hold"); const text = stream.text();
    const leasePath = path.join(f.data, "handoff-write-lease/owner.json");
    const before = JSON.parse(await readFile(leasePath, "utf8"));
    await until(async () => JSON.parse(await readFile(leasePath, "utf8")).expiresAt > before.expiresAt + 1000);
    const owner = await readFile(leasePath, "utf8");
    await writeFile(leasePath, JSON.stringify({ ...JSON.parse(owner), epoch: "故障注入-不同持有者" }));
    await until(() => supervisor.state().leaseFault);
    const waiting = post(f.publicPort, "queued-during-fault");
    await until(() => supervisor.listener.queue.stats().queuedRequests === 1);
    await pause(100); assert.equal(f.calls(), 1, "租约异常期间不得发送新的业务请求");
    f.release(); assert.match(await text, /response.completed/);
    await writeFile(leasePath, owner);
    await until(() => !supervisor.state().leaseFault);
    const resumed = await waiting; assert.equal(resumed.status, 200); await resumed.text();
    await until(async () => (await f.records()).length === 2);
    assert.equal(f.calls(), 2);
    assert.equal(events.filter((line) => line.includes('"event":"handoff_lease_degraded"')).length, 1);
    assert.equal(events.filter((line) => line.includes('"event":"handoff_lease_recovered"')).length, 1);
    context.diagnostic(JSON.stringify({ ttlCrossed: true, activeSseCompleted: true, queuedRequestSentOnce: true, records: 2 }));
  });

  await t.test("监督器被杀后旧工作进程排空期间禁止接管，退出后安全恢复", async (context) => {
    const f = await fixture("orphan", context);
    const harness = path.join(root, "orphan-runner.mjs");
    await writeFile(harness, `// 中文演练入口：独立监督器用于强制退出测试。\nimport { createHandoffSupervisor } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "lib/handoff-supervisor.js")).href)};\nconst supervisor=await createHandoffSupervisor(${JSON.stringify(f.options)});\nconst worker=await supervisor.start();\nconsole.log(JSON.stringify({ready:true,pid:worker.pid,port:worker.mainPort}));\nprocess.on("SIGTERM",()=>supervisor.close());\n`);
    const child = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errors = ""; let workerPid = null; let recovered = null;
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; });
    const exited = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    context.after(async () => {
      f.release();
      if (recovered) await recovered.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      if (workerPid && alive(workerPid)) { process.kill(workerPid, "SIGTERM"); await until(() => !alive(workerPid), 5000).catch(() => process.kill(workerPid, "SIGKILL")); }
    });
    const ready = await until(() => {
      if (child.exitCode !== null) throw new Error(`测试监督器提前退出：${errors}`);
      return output.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((value) => value.ready);
    });
    workerPid = ready.pid;
    // 直接保持工作进程的既有连接，用于验证监督器死亡后的排空写入边界；不声称公开连接能跨进程死亡保留。
    const stream = await post(ready.port, "hold"); const text = stream.text();
    child.kill("SIGKILL"); await exited;
    assert.ok(alive(workerPid), "旧工作进程必须仍在排空");
    const competing = await createHandoffSupervisor(f.options);
    await assert.rejects(competing.start(), /子进程仍在排空或运行/);
    await assert.rejects(readFile(path.join(f.data, "handoff-last-close.json")), { code: "ENOENT" });
    f.release(); assert.match(await text, /response.completed/);
    await until(() => !alive(workerPid));
    recovered = await createHandoffSupervisor(f.options); await recovered.start();
    const response = await post(f.publicPort, "after-recovery"); assert.equal(response.status, 200); await response.text();
    await until(async () => (await f.records()).length === 2);
    assert.equal(f.calls(), 2);
    context.diagnostic(JSON.stringify({ orphanDrainProtected: true, recoveryAfterWorkerExit: true, records: 2 }));
  });
});
