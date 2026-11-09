/**
 * 实时流量集成测试：仅启动独立临时实例与本机伪上游，覆盖并发流、检测、实验和失败清理。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("等待实时流量状态超时");
}

test("多供应商流量真实并发、五秒过期推送和各类上游请求统计", { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-activity-"));
  const held = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url.startsWith("/failed/")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "test unauthorized" } }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
    }
    held.push({ res, body });
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  await writeFile(path.join(root, "config.json"), JSON.stringify({
    proxy: { autoFailoverEnabled: false, currentProviderId: "a", maxAttempts: 1 },
    providers: ["a", "b", "failed"].map((id) => ({
      id, name: `测试 ${id}`, baseUrl: `http://127.0.0.1:${upstreamPort}/${id}/v1`, apiKey: "test", enabled: true,
    })).concat([{ id: "local-auth-error", name: "本地认证失败", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, authMode: "oauth_file", oauthFilePath: path.join(root, "absent-auth.json") }]),
    connectivityTest: { candidateModels: ["activity-test"], periodicIntervalMs: null },
  }));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...env, LITE_CCSWITCH_DATA_DIR: root, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(port), LITE_CCSWITCH_SHUTDOWN_GRACE_MS: "200" },
    stdio: "ignore",
  });
  const eventsController = new AbortController();
  t.after(async () => {
    eventsController.abort();
    held.forEach(({ res }) => res.destroy());
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1500))]);
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const status = async () => fetch(`${base}/api/status`).then((r) => r.json());
  const post = (url, body = {}) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const select = (id) => post(`/api/providers/${id}/select`);
  const request = () => post("/v1/responses", { model: "activity-test", input: "test", stream: true });
  const finish = (entry) => {
    if (entry.body.stream) entry.res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    else entry.res.end(JSON.stringify({ model: "activity-test", output: [{ content: [{ type: "output_text", text: "CCOK" }] }] }));
  };
  await waitFor(async () => { try { return await status(); } catch { return false; } });
  assert.deepEqual((await status()).providerActivity.providers, []);
  await select("b");
  assert.deepEqual((await status()).providerActivity.providers, [], "手动选择不应制造流量");
  await select("a");
  const a1 = await request();
  const a2 = await request();
  await select("b");
  const b = await request();
  const active = (await status()).providerActivity;
  assert.equal(active.windowMs, 5000);
  assert.deepEqual(active.providers.map((p) => [p.providerId, p.activeRequests]), [["a", 2], ["b", 1]]);

  let sawExpiry = false;
  const events = await fetch(`${base}/api/status/events`, { signal: eventsController.signal });
  const readEvents = (async () => {
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) {
            const providers = JSON.parse(data.slice(6)).providerActivity.providers;
            if (!providers.some((p) => p.providerId === "a") && providers.some((p) => p.providerId === "b" && p.activeRequests === 1)) sawExpiry = true;
          }
        }
      }
    } catch (error) { if (error.name !== "AbortError") throw error; }
  })();
  finish(held[0]); await a1.text();
  await waitFor(async () => (await status()).providerActivity.providers.find((p) => p.providerId === "a")?.activeRequests === 1);
  finish(held[1]); await a2.text();
  await waitFor(async () => (await status()).providerActivity.providers.find((p) => p.providerId === "a")?.activeRequests === 0);
  await waitFor(async () => !(await status()).providerActivity.providers.some((p) => p.providerId === "a"), 6500);
  await waitFor(() => sawExpiry);
  assert.equal((await status()).providerActivity.providers.find((p) => p.providerId === "b").activeRequests, 1, "超过五秒的长流仍必须显示");
  finish(held[2]); await b.text();

  const check = post("/api/providers/a/test");
  await waitFor(async () => (await status()).providerActivity.providers.find((p) => p.providerId === "a")?.activeByKind.health_check === 1);
  await waitFor(() => held[3]);
  finish(held[3]); assert.equal((await check).status, 200);
  await waitFor(async () => (await status()).providerActivity.providers.find((p) => p.providerId === "a")?.activeRequests === 0);
  const experiment = post("/api/price-lab/requests", { providerId: "a", model: "activity-test", kind: "input_short" });
  await waitFor(async () => (await status()).providerActivity.providers.find((p) => p.providerId === "a")?.activeByKind.price_experiment === 1);
  await waitFor(() => held[4]);
  finish(held[4]); assert.equal((await experiment).status, 201);
  await select("failed");
  assert.equal((await request()).status, 401);
  await waitFor(async () => (await status()).providerActivity.providers.find((p) => p.providerId === "failed")?.activeRequests === 0);
  await select("local-auth-error");
  await request();
  assert.equal((await status()).providerActivity.providers.some((p) => p.providerId === "local-auth-error"), false, "本地认证失败没有发出上游请求，不应制造流量");
  eventsController.abort(); await readEvents;
});
