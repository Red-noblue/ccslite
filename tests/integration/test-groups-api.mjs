/**
 * 分组管理接口集成测试。
 * 验证旧配置迁移为默认分组，以及复制分组时完整保留供应商引用。
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

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(base, child, logs) {
  for (let index = 0; index < 80; index += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务启动失败：${logs()}`);
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) return;
    } catch {
      // 服务尚未监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`测试服务启动超时：${logs()}`);
}

test("旧配置迁移为默认分组，复制接口保留全部供应商引用", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-groups-api-"));
  const configPath = path.join(root, "config.json");
  const usagePath = path.join(root, "usage.jsonl");
  const port = await reservePort();
  await writeFile(configPath, JSON.stringify({
    version: 1,
    proxy: { autoFailoverEnabled: true },
    providers: [
      { id: "cheap", name: "低价供应商", baseUrl: "http://127.0.0.1:1", apiKey: "cheap" },
      { id: "reliable", name: "高可靠供应商", baseUrl: "http://127.0.0.1:2", apiKey: "reliable" },
    ],
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...env,
      LITE_CCSWITCH_HOST: "127.0.0.1",
      LITE_CCSWITCH_PORT: String(port),
      LITE_CCSWITCH_CONFIG: configPath,
      LITE_CCSWITCH_USAGE: usagePath,
      LITE_CCSWITCH_DATA_DIR: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base, child, () => logs);
  const groupsResponse = await fetch(`${base}/api/groups`);
  assert.equal(groupsResponse.status, 200);
  const groups = await groupsResponse.json();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].actualListener.port, port);
  assert.equal(groups[0].listenerStatus, "listening");
  assert.deepEqual(groups[0].providerRefs.map((item) => item.providerId), ["cheap", "reliable"]);

  const cloneResponse = await fetch(`${base}/api/groups/default/clone`, { method: "POST" });
  assert.equal(cloneResponse.status, 201);
  const copy = await cloneResponse.json();
  assert.notEqual(copy.id, "default");
  assert.ok(copy.listener.port > port, "自动分配端口应跳过已被其他进程占用的端口");
  assert.equal(copy.listener.enabled, true);
  assert.equal(copy.actualListener.port, copy.listener.port);
  assert.equal(copy.listenerStatus, "listening");
  assert.deepEqual(copy.providerRefs.map((item) => item.providerId), ["cheap", "reliable"]);

  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.groups.length, 2);
  assert.deepEqual(persisted.groups[1].providerRefs.map((item) => item.providerId), ["cheap", "reliable"]);

  const update = async (url, payload) => {
    const response = await fetch(`${base}${url}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const pinnedDefault = await update("/api/groups/default", { listener: { port: 15723 } });
  assert.equal(pinnedDefault.listener.port, port);
  assert.equal(pinnedDefault.actualListener.port, port);
  await update("/api/groups/default", { theme: { accentMode: "custom", accent: "#123456", accentLocked: false } });
  await update(`/api/groups/${copy.id}`, { theme: { accentMode: "custom", accent: "#654321", accentLocked: true } });
  await update("/api/config", { ui: { palette: "macaron" } });
  let themed = await fetch(`${base}/api/groups`).then((response) => response.json());
  assert.equal(themed[0].theme.accent, "#dc93b0");
  assert.equal(themed[0].theme.accentMode, "custom");
  assert.equal(themed[1].theme.accent, "#654321");
  await update("/api/config", { ui: { palette: "oil" } });
  themed = await fetch(`${base}/api/groups`).then((response) => response.json());
  assert.equal(themed[0].theme.accent, "#a65f43");
  assert.equal(themed[1].theme.accent, "#654321");
  const status = await fetch(`${base}/api/status`).then((response) => response.json());
  for (const key of ["configPath", "usagePath", "priceLabPath"]) assert.ok(status.persistence[key].startsWith(root));
});
