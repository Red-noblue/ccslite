/**
 * 分组用量隔离集成测试：独立目录与本机伪上游验证旧日志、复制、计费、实验和重启恢复。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
};

test("复制只保留配置，跨组计费、活动与价格数据隔离且重启后保持", { timeout: 12000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-group-usage-"));
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { /* 消费本机测试请求体。 */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "group-test", output: [{ content: [{ type: "output_text", text: "CCOK" }] }], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } }));
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  await writeFile(path.join(root, "config.json"), JSON.stringify({
    proxy: { autoFailoverEnabled: false, currentProviderId: "shared" },
    providers: [{ id: "shared", name: "共享测试供应商", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "test" }],
    connectivityTest: { candidateModels: ["group-test"], periodicIntervalMs: null },
  }));
  await writeFile(path.join(root, "usage.jsonl"), [
    { id: "old-ok", providerId: "shared", providerName: "共享测试供应商", statusCode: 200 },
    { id: "old-error", providerId: "shared", statusCode: 500, error: "test" },
    { id: "old-probe", providerId: "shared", statusCode: 200, usageCategory: "ccok_probe" },
  ].map((record) => JSON.stringify({ timestamp: new Date().toISOString(), ...record })).join("\n") + "\n");
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  let child;
  const start = async () => {
    child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT, stdio: "ignore",
      env: { ...cleanEnv, LITE_CCSWITCH_DATA_DIR: root, LITE_CCSWITCH_PORT: String(port), LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_SHUTDOWN_GRACE_MS: "200" },
    });
    for (let n = 0; n < 100; n += 1) {
      try { if ((await fetch(`${base}/api/status`)).ok) return; } catch { /* 等待独立实例启动。 */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("隔离实例未启动");
  };
  const stop = async () => {
    if (child?.exitCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  };
  t.after(async () => {
    await stop(); upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const get = async (url) => {
    const response = await fetch(`${base}${url}`); assert.equal(response.status, 200); return response.json();
  };
  const post = async (url, body = {}) => {
    const response = await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${url}: ${response.status}`); return response.json();
  };
  await start();
  let status = await get("/api/status");
  assert.equal(status.groups[0].statistics.totalRequests, 2);
  assert.equal(status.groups[0].statistics.successRate, 50);
  assert.deepEqual(status.groups[0].providerActivity.providers, []);
  const copy = await post("/api/groups/default/clone");
  assert.equal(copy.statistics.totalRequests, 0);
  assert.deepEqual(copy.providerActivity.providers, []);
  assert.equal(copy.providerRefs[0].providerId, "shared");
  const query = `groupId=${encodeURIComponent(copy.id)}`;
  assert.equal((await get(`/api/billing/summary?${query}`)).totalRequests, 0);
  assert.equal((await get(`/api/billing/logs?${query}`)).totalRecords, 0);
  await post("/v1/responses", { model: "group-test", input: "test" });
  // 响应可能先于用量落盘完成，等待管理台统计完成本次请求。
  for (let n = 0; n < 100; n += 1) {
    status = await get("/api/status");
    if (status.groups[0].statistics.successRequests === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(status.groups[0].statistics.totalRequests, 3);
  assert.equal(status.groups.find((group) => group.id === copy.id).statistics.totalRequests, 0);
  assert.deepEqual(status.groups.find((group) => group.id === copy.id).providerActivity.providers, []);
  await post(`/api/providers/shared/test?${query}`);
  const copiedBilling = await get(`/api/billing/summary?${query}`);
  assert.equal(copiedBilling.totalRequests, 1);
  assert.equal(copiedBilling.business.totalRequests, 0);
  assert.equal(copiedBilling.ccok.totalRequests, 1);
  assert.equal((await get("/api/billing/summary?groupId=default")).totalRequests, 4);
  assert.ok((await get(`/api/billing/logs?${query}`)).records.every((record) => record.groupId === copy.id));
  await post("/api/price-lab/requests?groupId=default", { providerId: "shared", model: "group-test" });
  assert.equal((await get(`/api/price-lab?${query}`)).samples.length, 0);
  await post(`/api/price-lab/requests?${query}`, { providerId: "shared", model: "group-test" });
  assert.equal((await get("/api/price-lab?groupId=default")).samples.length, 1);
  assert.equal((await get(`/api/price-lab?${query}`)).samples.length, 1);
  const priceFiles = [path.join(root, "price-lab.json"), path.join(root, "group-price-lab", `${encodeURIComponent(copy.id)}.json`)];
  const priceData = await Promise.all(priceFiles.map((file) => readFile(file, "utf8").then(JSON.parse)));
  assert.notEqual(priceData[0].samples[0].id, priceData[1].samples[0].id);
  const third = await post(`/api/groups/${copy.id}/clone`);
  assert.equal(third.statistics.totalRequests, 0);
  assert.deepEqual(third.providerActivity.providers, []);
  assert.equal((await get(`/api/price-lab?groupId=${third.id}`)).samples.length, 0);
  await stop(); await start();
  status = await get("/api/status");
  assert.equal(status.groups[0].statistics.totalRequests, 3);
  assert.equal(status.groups.find((group) => group.id === copy.id).statistics.totalRequests, 0);
  assert.ok(status.groups.every((group) => group.providerActivity.providers.length === 0));
  assert.equal((await get(`/api/billing/summary?${query}`)).ccok.totalRequests, 1);
  assert.equal((await get(`/api/price-lab?${query}`)).samples.length, 1);
});
