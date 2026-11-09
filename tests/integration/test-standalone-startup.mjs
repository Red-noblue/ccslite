/** 中文独立安装验收：空配置首次启动和目录改名后继续启动，均不依赖外层工具包或真实供应商。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("干净副本首次生成空配置，改名为含空格的目录后配置与页面仍可使用", { timeout: 60000 }, async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "ccslite-standalone-"));
  let root = path.join(sandbox, "initial");
  let child;
  let exited;
  const stop = async () => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGTERM");
    if (exited) await exited;
  };
  t.after(async () => { await stop(); await rm(sandbox, { recursive: true, force: true }); });
  await createReleaseSnapshot(source, root, "standalone-test");
  await rm(path.join(root, "release-manifest.json"));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_") && key !== "NODE_PATH"));
  const start = async () => {
    let logs = "";
    child = spawn(process.execPath, [path.join(root, "server.js")], {
      cwd: sandbox, env: { ...env, LITE_CCSWITCH_HOST: "127.0.0.1", LITE_CCSWITCH_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = new Promise((resolve) => child.once("close", resolve));
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    for (let i = 0; i < 400; i += 1) {
      if (child.exitCode !== null) throw new Error(`独立启动失败：${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        if (response.ok) return response.json();
      } catch { /* 等待本次测试进程完成初始化。 */ }
      await pause(25);
    }
    throw new Error(`独立启动超时：${logs}`);
  };
  const status = await start();
  assert.equal(status.running, true);
  const config = JSON.parse(await readFile(path.join(root, "data/config.json"), "utf8"));
  assert.equal(config.version, 2);
  assert.deepEqual(config.providers, []);
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base).then((response) => response.text());
  for (const [, asset] of page.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  await stop();
  const renamed = path.join(sandbox, "重命名 独立项目");
  await rename(root, renamed);
  root = renamed;
  const restarted = await start();
  assert.equal(restarted.running, true);
  assert.equal(restarted.build.codeHash, status.build.codeHash);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "data/config.json"), "utf8")).providers, []);
});
