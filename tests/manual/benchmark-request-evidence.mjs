/** 请求证据开销对比：隔离启动旧版和候选，交替测量本机模拟请求；不读生产数据、不联系真实供应商。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const production = path.basename(path.dirname(candidate)) === "releases" ? path.resolve(candidate, "../..") : candidate;
const baseline = process.env.LITE_EVIDENCE_BENCH_BASELINE || path.join(production, "releases/0.2.20-rc.4-readiness-20261111");
const root = await mkdtemp(path.join(tmpdir(), "lite-evidence-bench-")); let child;
const upstream = createServer(async (req, res) => {
  for await (const _chunk of req) { /* 读取完整模拟请求。 */ }
  res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"bench","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}');
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); assert.ok(server.address().port >= 15725); return server.address().port; }
const samples = { baseline: [], candidate: [] };
try {
  const upstreamPort = await listen(upstream);
  for (const [index, kind] of ["baseline", "candidate", "candidate", "baseline"].entries()) {
    const data = path.join(root, String(index)); const fs = await import("node:fs/promises"); await fs.mkdir(data);
    const reservation = createServer(); const port = await listen(reservation); await new Promise((resolve) => reservation.close(resolve));
    await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false, currentProviderId: "mock" }, providers: [{ id: "mock", name: "模拟", apiKey: "synthetic", baseUrl: `http://127.0.0.1:${upstreamPort}`, routingEnabled: true }], connectivityTest: { periodicIntervalMs: null } }));
    const codeRoot = kind === "baseline" ? baseline : candidate;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
    child = spawn(process.execPath, [path.join(codeRoot, "server.js")], { cwd: codeRoot, env: { ...env, LITE_CCSWITCH_DATA_DIR: data, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(port) }, stdio: "ignore" });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let n = 0; n < 200; n++) { if (await fetch(base + "/api/status").then((response) => response.ok, () => false)) { ready = true; break; } await pause(20); }
    assert.equal(ready, true, `${kind} 未启动`);
    for (let n = 0; n < 115; n++) {
      const started = performance.now();
      const response = await fetch(base + "/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": "benchmark" }, body: '{"model":"mock","input":"synthetic"}' });
      assert.equal(response.status, 200); await response.text();
      if (n >= 15) samples[kind].push(performance.now() - started);
    }
    const done = once(child, "exit"); child.kill("SIGTERM"); await done; child = null;
  }
  const summary = Object.fromEntries(Object.entries(samples).map(([kind, values]) => {
    values.sort((a, b) => a - b);
    return [kind, { count: values.length, p50Ms: values[Math.floor(values.length * .5)], p95Ms: values[Math.floor(values.length * .95)] }];
  }));
  const deltaP95Ms = summary.candidate.p95Ms - summary.baseline.p95Ms;
  console.log(JSON.stringify({ simulated: true, nodeVersion: process.version, baseline: path.basename(baseline), candidate: path.basename(candidate), ...summary, deltaP95Ms, withinOneSecond: deltaP95Ms < 1000 }, null, 2));
  assert.ok(deltaP95Ms < 1000, "候选请求 p95 相对基线新增延时应小于 1 秒");
} finally {
  if (child?.exitCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
  upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true });
}
