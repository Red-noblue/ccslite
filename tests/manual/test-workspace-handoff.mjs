/**
 * 中文源码模式演练：验证根目录前置器直接启动根目录工作进程，并使用独立回退包。
 * 自动创建并清理独立副本，不使用或删除待测仓库自己的 data 目录。
 * 只使用本机假上游、独立数据目录和 15725 以上端口，不连接正式服务。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sandbox = await mkdtemp(path.join(tmpdir(), "ccslite-workspace-"));
const root = path.join(sandbox, "workspace");
const data = path.join(root, "data");
const fallback = path.join(sandbox, "fallback");
const fallbackId = "workspace-test-fallback";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (server) => {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; assert.ok(port >= 15725); return port;
};
const reserve = async () => { const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; };
const until = async (check, timeoutMs = 20000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); } throw new Error("源码模式演练等待超时"); };
let child; let upstreamCalls = 0;
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk); upstreamCalls += 1;
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
  } else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}'); }
});
try {
  await createReleaseSnapshot(source, root, "workspace-test-source");
  await rm(path.join(root, "release-manifest.json"));
  await createReleaseSnapshot(source, fallback, fallbackId);
  const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
  const upstreamPort = await listen(upstream); const publicPort = await reserve(); const qualityPort = await reserve();
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "源码模式假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] },
      { id: "quality", name: "高质量", listener: { host: "127.0.0.1", port: qualityPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), JSON.stringify({ id: "history", statusCode: 200 }) + "\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  child = spawn(process.execPath, [path.join(root, "handoff-runner.mjs"), "--workspace", "--fallback", fallback, "--data-dir", data, "--port", String(publicPort)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  try { await until(() => stdout.includes('"event":"ready"')); }
  catch (error) { throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`); }
  const status = await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json());
  assert.equal(status.build.version, version); assert.equal(status.build.packaged, false); assert.match(status.build.releaseId, /^workspace-/);
  assert.equal(status.handoff.listener, "fixed"); assert.equal(status.port, publicPort);
  assert.equal(status.groups.find((group) => group.id === "quality").actualListener.port, qualityPort);
  for (const port of [publicPort, qualityPort]) { const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "workspace", stream: true }) }); assert.equal(response.status, 200); assert.match(await response.text(), /response.completed/); }
  const usage = (await readFile(path.join(data, "usage.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
  if (usage.length < 2) console.error(`workspace usage records: ${JSON.stringify(usage)}`);
  assert.ok(usage.length >= 2); assert.equal(upstreamCalls, 2);
  const workerPid = status.processId;
  process.kill(workerPid, "SIGKILL");
  const recovered = await until(async () => {
    try { const value = await fetch(`http://127.0.0.1:${publicPort}/api/status`).then((r) => r.json()); return value.build?.releaseId === fallbackId ? value : false; }
    catch { return false; }
  });
  assert.equal(recovered.build.packaged, true);
  const afterCrash = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "fallback" }) });
  assert.equal(afterCrash.status, 200); await afterCrash.text();
  child.kill("SIGTERM"); const stopped = await exit; assert.equal(stopped.code, 0, stderr); assert.match(stdout, /"event":"stopped"/);
  console.log(JSON.stringify({ passed: true, mode: "workspace", version: status.build.version, releaseId: status.build.releaseId, recoveredRelease: recovered.build.releaseId, publicPort, qualityPort, upstreamCalls, usageRecords: usage.length, productionChanged: false }));
} finally {
  if (child?.exitCode === null && child?.signalCode === null) {
    const stopped = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    await stopped;
  }
  upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
