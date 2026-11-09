/**
 * 默认分组路由一致性测试：验证 providerRefs 同时约束实际请求和恢复探测资格。
 * 使用独立配置、端口和本机假上游，不读取或修改正式数据。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

test("默认分组 providerRefs 与实际路由、CCOK 资格保持一致", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-default-group-routing-"));
  const usagePath = path.join(root, "usage.jsonl");
  let enabledCalls = 0;
  let disabledCalls = 0;
  const enabledUpstream = createServer((req, res) => {
    enabledCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "model-a", output: [{ content: [{ type: "output_text", text: "enabled" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  const disabledUpstream = createServer((req, res) => {
    disabledCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "model-a", output: [{ content: [{ type: "output_text", text: "disabled" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  const enabledPort = await listen(enabledUpstream);
  const disabledPort = await listen(disabledUpstream);
  const reservation = createServer();
  const proxyPort = await listen(reservation);
  await close(reservation);
  await writeFile(path.join(root, "config.json"), JSON.stringify({
    version: 2,
    proxy: { autoFailoverEnabled: true, maxAttempts: 2 },
    providers: [
      { id: "enabled", name: "猫猫 1", baseUrl: `http://127.0.0.1:${enabledPort}/v1`, apiKey: "enabled", routingEnabled: true, sortIndex: 1 },
      { id: "disabled", name: "aimz-test1", baseUrl: `http://127.0.0.1:${disabledPort}/v1`, apiKey: "disabled", routingEnabled: true, sortIndex: 2 },
    ],
    groups: [{ id: "default", name: "默认", listener: { host: "127.0.0.1", port: proxyPort, enabled: true }, providerRefs: [
      { providerId: "enabled", enabled: true, sortIndex: 1 },
      { providerId: "disabled", enabled: false, sortIndex: 1 },
    ] }],
    connectivityTest: { periodicIntervalMs: null, candidateModels: ["model-a"] },
  }));
  await writeFile(usagePath, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...env, LITE_CCSWITCH_DATA_DIR: root, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(proxyPort), LITE_CCSWITCH_USAGE: usagePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await close(enabledUpstream); await close(disabledUpstream); await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${proxyPort}`;
  for (let index = 0; index < 80; index += 1) {
    try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* 等待启动。 */ }
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const providers = await (await fetch(`${base}/api/providers`)).json();
  assert.equal(providers.find((provider) => provider.id === "disabled").routingEnabled, false);
  assert.deepEqual(providers.map((provider) => provider.id), ["enabled", "disabled"]);
  const status = await (await fetch(`${base}/api/status`)).json();
  const defaultGroupProviders = await (await fetch(`${base}/api/providers?groupId=default`)).json();
  const config = await (await fetch(`${base}/api/config?groupId=default`)).json();
  assert.deepEqual(
    status.providers.map(({ id, routingEnabled, sortIndex }) => ({ id, routingEnabled, sortIndex })),
    defaultGroupProviders.map(({ id, routingEnabled, sortIndex }) => ({ id, routingEnabled, sortIndex })),
  );
  assert.deepEqual(
    config.providers.map(({ id, routingEnabled, sortIndex }) => ({ id, routingEnabled, sortIndex })),
    defaultGroupProviders.map(({ id, routingEnabled, sortIndex }) => ({ id, routingEnabled, sortIndex })),
  );
  assert.equal(status.providers.find((provider) => provider.id === "disabled").routingEnabled, false);
  assert.equal(status.groups[0].activeProviderCount, 1);
  assert.equal(status.recoveryProbes.some((probe) => probe.providerId === "disabled"), false);
  const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "model-a", input: "test" }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lite-ccswitch-provider-id"), "enabled");
  await response.text();
  assert.equal(enabledCalls, 1);
  assert.equal(disabledCalls, 0);
  const persisted = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
  assert.equal(persisted.groups[0].providerRefs.find((ref) => ref.providerId === "disabled").enabled, false);
  assert.equal(persisted.providers.find((provider) => provider.id === "disabled").routingEnabled, false);
  assert.equal(persisted.providers.find((provider) => provider.id === "disabled").enabled, false);
});
