/**
 * 中文工作进程模式验收：验证私有主/分组端口、只读预热、IPC 激活和数据不被预热改写。
 * 使用假的本机上游和独立临时数据，不访问正式项目或真实供应商。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; assert.ok(port >= 15725); return port;
}
async function reserve() { const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }
async function until(check) {
  for (let i = 0; i < 200; i += 1) { const value = await check(); if (value) return value; await pause(10); }
  throw new Error("等待工作进程超时");
}

test("只读预热使用私有端口，激活后才接受业务请求", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-worker-"));
  const data = path.join(root, "data"); await mkdir(data, { recursive: true }); const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const upstreamPort = await listen(upstream); const publicPort = await reserve(); const qualityPort = await reserve();
  const privateMain = await reserve(); const privateQuality = await reserve();
  const config = { version: 2, proxy: { autoFailoverEnabled: false, currentProviderId: "local" },
    providers: [{ id: "local", name: "本机假供应商", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] },
      { id: "quality", routingVersion: 1, name: "质量", listener: { host: "127.0.0.1", port: qualityPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }],
    connectivityTest: { periodicIntervalMs: null } };
  await writeFile(path.join(data, "config.json"), JSON.stringify(config)); await writeFile(path.join(data, "usage.jsonl"), "");
  const before = createHash("sha256").update(await readFile(path.join(data, "config.json"))).digest("hex");
  const env = { ...process.env, LITE_CCSWITCH_DATA_DIR: data, LITE_CCSWITCH_CONFIG: path.join(data, "config.json"),
    LITE_CCSWITCH_USAGE: path.join(data, "usage.jsonl"), LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(privateMain),
    LITE_CCSWITCH_PUBLIC_PORT: String(publicPort), LITE_CCSWITCH_HANDOFF_WORKER: "1", LITE_CCSWITCH_HANDOFF_READ_ONLY: "1",
    LITE_CCSWITCH_HANDOFF_GROUP_PORTS: JSON.stringify({ quality: privateQuality }) };
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = ""; let stderr = ""; child.stdout.on("data", (c) => { stdout += c; }); child.stderr.on("data", (c) => { stderr += c; });
  // 独立工作进程演练没有监督器，给新增的持久化 IPC 提供最小确认，避免业务请求一直等待。
  child.on("message", (message) => {
    if (message?.type === "handoff_read_config") {
      child.send({ type: "handoff_control_result", requestId: message.requestId, result: { config, revision: 0 } });
      return;
    }
    if (!["handoff_persist_usage", "handoff_persist_config", "handoff_persist_diagnostic", "handoff_session_checkpoint"].includes(message?.type)) return;
    child.send({ type: "handoff_control_result", requestId: message.requestId, result: {} });
  });
  const exit = new Promise((resolve, reject) => { child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await Promise.race([exit, pause(3000)]); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const status = async (port) => fetch(`http://127.0.0.1:${port}/api/status`).then((response) => response.json());
  const ready = await until(async () => { try { const s = await status(privateMain); return s.running && s.handoff?.readOnly === true ? s : false; } catch { return false; } });
  assert.equal(ready.port, privateMain); assert.equal(ready.publicPort, publicPort);
  assert.equal(ready.groups.find((g) => g.id === "quality").actualListener.port, privateQuality);
  const beforeBusiness = await fetch(`http://127.0.0.1:${privateMain}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "warmup" }) });
  assert.equal(beforeBusiness.status, 503); assert.equal((await status(privateMain)).connectivityTest.running, false);
  const afterWarmup = createHash("sha256").update(await readFile(path.join(data, "config.json"))).digest("hex"); assert.equal(afterWarmup, before);
  const activated = new Promise((resolve) => {
    const listener = (message) => { if (message?.type === "handoff_activated") { child.off("message", listener); resolve(message); } };
    child.on("message", listener);
  });
  child.send({ type: "handoff_activate" }); await activated;
  const active = await until(async () => { try { const s = await status(privateMain); return s.handoff?.readOnly === false ? s : false; } catch { return false; } });
  assert.equal(active.port, privateMain);
  const response = await fetch(`http://127.0.0.1:${privateMain}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "active" }) });
  assert.equal(response.status, 200); await response.text();
  const quality = await fetch(`http://127.0.0.1:${privateQuality}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "quality" }) });
  assert.equal(quality.status, 200); await quality.text();
  child.kill("SIGTERM"); assert.equal((await exit).code, 0); assert.match(stdout, /只读预热/); assert.doesNotMatch(stderr, /错误|异常/);
});
