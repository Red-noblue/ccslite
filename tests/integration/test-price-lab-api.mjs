/**
 * 价格实验直连与逐条扣费集成测试。
 * 验证实验请求只命中指定供应商，且未录入上一条扣费时不会发送下一次请求。
 * 测试仅使用本机伪上游和临时目录，不访问真实供应商。
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

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitForServer(url, logs) {
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 服务尚未完成监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`价格实验测试服务启动超时：${logs()}`);
}

test("价格实验直连指定供应商并等待逐条录入扣费", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "lite-ccswitch-price-lab-"));
  const configPath = path.join(tempRoot, "config.json");
  const usagePath = path.join(tempRoot, "usage.jsonl");
  const priceLabPath = path.join(tempRoot, "price-lab.json");
  const exchangeRatePath = path.join(tempRoot, "exchange-rate.json");
  await writeFile(exchangeRatePath, JSON.stringify({
    version: 1, mode: "auto", autoRate: {
      base: "USD", quote: "CNY", rate: 6.5, rateDate: "2026-11-05",
      source: "frankfurter_ecb", fetchedAt: new Date().toISOString(),
    },
  }));
  let mainRequestCount = 0;
  let labRequestCount = 0;
  const labRequests = [];
  const mainUpstream = createServer((req, res) => {
    mainRequestCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const labUpstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    labRequests.push(request);
    labRequestCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: request.model,
      output_text: "PRICEOK",
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_tokens_details: {
          cached_tokens: 20,
          cache_write_tokens: 10,
        },
      },
    }));
  });
  const mainPort = await listen(mainUpstream);
  const labPort = await listen(labUpstream);
  const proxyPort = await reservePort();
  let childLogs = "";
  let proxyProcess = null;

  t.after(async () => {
    if (proxyProcess?.exitCode === null) {
      proxyProcess.kill("SIGTERM");
      await Promise.race([
        once(proxyProcess, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    await close(mainUpstream);
    await close(labUpstream);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: {
      autoFailoverEnabled: true,
      currentProviderId: "main",
    },
    providers: [
      {
        id: "main",
        name: "正常供应商",
        baseUrl: `http://127.0.0.1:${mainPort}`,
        apiKey: "main-key",
        enabled: true,
        inFailoverQueue: true,
        sortIndex: 1,
      },
      {
        id: "lab",
        name: "实验供应商",
        baseUrl: `http://127.0.0.1:${labPort}`,
        apiKey: "lab-key",
        enabled: true,
        inFailoverQueue: false,
        sortIndex: 99,
      },
    ],
    connectivityTest: { periodicIntervalMs: 10800000 },
  }, null, 2));

  proxyProcess = spawn(process.execPath, [path.join(TOOL_ROOT, "server.js")], {
    cwd: TOOL_ROOT,
    env: {
      ...process.env,
      LITE_CCSWITCH_HOST: "127.0.0.1",
      LITE_CCSWITCH_DATA_DIR: tempRoot,
      LITE_CCSWITCH_PORT: String(proxyPort),
      LITE_CCSWITCH_CONFIG: configPath,
      LITE_CCSWITCH_USAGE: usagePath,
      LITE_CCSWITCH_PRICE_LAB: priceLabPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxyProcess.stdout.on("data", (chunk) => { childLogs += chunk.toString(); });
  proxyProcess.stderr.on("data", (chunk) => { childLogs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForServer(`${baseUrl}/api/status`, () => childLogs);
  async function setRate(payload) {
    return fetch(`${baseUrl}/api/price-lab/exchange-rate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
  }
  const cachedRate = await (await setRate({})).json();
  assert.equal(cachedRate.rate.rate, 6.5);
  assert.equal((await setRate({ mode: "manual", rate: 0 })).status, 400);
  assert.equal((await setRate({ mode: "manual", rate: 7 })).status, 200);
  const manualRate = await (await fetch(`${baseUrl}/api/price-lab/exchange-rate`)).json();
  assert.equal(manualRate.rate.rate, 7);
  assert.equal(manualRate.mode, "manual");
  const invalidEffort = await fetch(`${baseUrl}/api/price-lab/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "lab", model: "gpt-6.1-sol", reasoningEffort: "invalid" }),
  });
  assert.equal(invalidEffort.status, 400);
  assert.equal(labRequestCount, 0, "无效思考强度不能产生付费请求");
  const firstResponse = await fetch(`${baseUrl}/api/price-lab/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId: "lab",
      model: "gpt-6.1-sol",
      reasoningEffort: "xhigh",
      currency: "USD",
      kind: "input_short",
    }),
  });
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.equal(labRequestCount, 1);
  assert.equal(mainRequestCount, 0);
  assert.equal(labRequests[0].model, "gpt-6.1-sol");
  assert.deepEqual(labRequests[0].reasoning, { effort: "xhigh" });
  assert.equal(first.sample.reasoningEffort, "xhigh");
  assert.equal(first.sample.currency, "USD");
  assert.equal(first.sample.usage.ordinaryInputTokens, 70);
  assert.equal(first.sample.usage.cacheReadTokens, 20);
  assert.equal(first.sample.usage.cacheCreationTokens, 10);

  const blockedResponse = await fetch(`${baseUrl}/api/price-lab/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "lab", model: "gpt-5.6-sol", kind: "input_long" }),
  });
  assert.equal(blockedResponse.status, 409);
  assert.equal(labRequestCount, 1);

  const billingResponse = await fetch(`${baseUrl}/api/price-lab/samples/${first.sample.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      billing: { ledgerCharge: 2, numerator: 80, denominator: 100, currency: "USD" },
    }),
  });
  assert.equal(billingResponse.status, 200);
  const billing = await billingResponse.json();
  assert.equal(billing.sample.billing.actualCost, 1.6);
  assert.equal(billing.sample.billing.exchangeRate.rate, 7);
  assert.equal(billing.priceLab.profiles[0].currency, "USD");

  const secondResponse = await fetch(`${baseUrl}/api/price-lab/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "lab", model: "gpt-5.6-sol", kind: "input_long" }),
  });
  assert.equal(secondResponse.status, 201);
  assert.equal(labRequestCount, 2);
  assert.ok(!Object.hasOwn(labRequests[1], "reasoning"), "旧客户端未选择思考强度时保留上游默认行为");
  assert.equal(mainRequestCount, 0);

  const second = await secondResponse.json();
  const invalidateResponse = await fetch(`${baseUrl}/api/price-lab/samples/${second.sample.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ valid: false, invalidReason: "测试继续进行" }),
  });
  assert.equal(invalidateResponse.status, 200);

  const deleteResponse = await fetch(`${baseUrl}/api/price-lab/samples/${second.sample.id}`, {
    method: "DELETE",
  });
  assert.equal(deleteResponse.status, 200);
  const deleted = await deleteResponse.json();
  assert.equal(deleted.deleted.id, second.sample.id);

  const cacheWriteResponse = await fetch(`${baseUrl}/api/price-lab/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "lab", model: "gpt-5.6-sol", currency: "CNY", kind: "cache_write" }),
  });
  assert.equal(cacheWriteResponse.status, 201);
  const cacheWrite = await cacheWriteResponse.json();
  assert.equal((await setRate({ mode: "manual", rate: 8 })).status, 200);
  const cacheBillingResponse = await fetch(`${baseUrl}/api/price-lab/samples/${cacheWrite.sample.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ billing: { ledgerCharge: 2, numerator: 1, denominator: 1, currency: "CNY" } }),
  });
  assert.equal(cacheBillingResponse.status, 200);

  const cacheReadResponse = await fetch(`${baseUrl}/api/price-lab/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "lab", model: "gpt-5.6-sol", currency: "CNY", kind: "cache_read" }),
  });
  assert.equal(cacheReadResponse.status, 201);
  const cacheRead = await cacheReadResponse.json();
  assert.equal(cacheRead.sample.cacheKey, cacheWrite.sample.cacheKey);
  assert.equal(labRequestCount, 4);

  const checkpointResponse = await fetch(`${baseUrl}/api/price-lab/checkpoints`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId: "lab",
      model: "gpt-5.6-sol",
      currency: "CNY",
      cumulativeLedgerCharge: 10,
      mode: "baseline",
    }),
  });
  assert.equal(checkpointResponse.status, 201);
  const checkpoint = await checkpointResponse.json();
  const intervalResponse = await fetch(`${baseUrl}/api/price-lab/checkpoints`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "lab", model: "gpt-5.6-sol", currency: "CNY", cumulativeLedgerCharge: 11 }),
  });
  assert.equal(intervalResponse.status, 201);
  const interval = await intervalResponse.json();
  assert.equal(interval.checkpoint.actualCost, 1);
  assert.equal(interval.checkpoint.exchangeRate.rate, 8);
  await fetch(`${baseUrl}/api/price-lab/checkpoints/${interval.checkpoint.id}`, { method: "DELETE" });
  const deleteCheckpointResponse = await fetch(`${baseUrl}/api/price-lab/checkpoints/${checkpoint.checkpoint.id}`, {
    method: "DELETE",
  });
  assert.equal(deleteCheckpointResponse.status, 200);
  const deletedCheckpoint = await deleteCheckpointResponse.json();
  assert.equal(deletedCheckpoint.deleted.id, checkpoint.checkpoint.id);

  const savedState = JSON.parse(await readFile(priceLabPath, "utf8"));
  assert.equal(savedState.samples.length, 3);
  assert.equal(savedState.samples.some((item) => item.id === second.sample.id), false);
  assert.equal(savedState.checkpoints.length, 0);
  assert.equal(savedState.samples[0].billing.actualCost, 1.6);
  assert.equal(savedState.samples[0].billing.exchangeRate.rate, 7);
  assert.equal(savedState.samples.find((item) => item.id === cacheWrite.sample.id).billing.exchangeRate.rate, 8);
  const savedBeforeRateChange = await readFile(priceLabPath, "utf8");
  assert.equal((await setRate({ mode: "manual", rate: 9 })).status, 200);
  assert.equal(await readFile(priceLabPath, "utf8"), savedBeforeRateChange, "汇率更新不改写历史金额或系数快照");
  assert.equal(savedState.samples[0].currency, "USD");
  assert.equal(savedState.samples[0].reasoningEffort, "xhigh");
  assert.deepEqual(new Set(Object.values(savedState.profiles).map((item) => item.currency)), new Set(["CNY", "USD"]));
});
