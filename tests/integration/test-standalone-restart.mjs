/** 中文独立重启验收：相对路径启动可被本项目识别，另一目录的同名服务必须保持运行。 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t, foreign) {
  const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "ccslite-restart-")));
  const root = path.join(sandbox, "current");
  const other = path.join(sandbox, "other");
  await mkdir(root); await mkdir(other);
  await copyFile(new URL("../../restart.sh", import.meta.url), path.join(root, "restart.sh"));
  await mkdir(path.join(root, "lib"));
  await copyFile(new URL("../../lib/runtime-config.js", import.meta.url), path.join(root, "lib/runtime-config.js"));
  const serverCode = `// 中文重启测试服务：只提供本机就绪状态，不连接任何供应商。
import http from 'node:http';
const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ processId: process.pid })); });
server.listen(Number(process.env.LITE_CCSWITCH_PORT), '127.0.0.1');
process.on('SIGTERM', () => { server.close(); server.closeIdleConnections(); });
`;
  for (const directory of [root, other]) {
    await writeFile(path.join(directory, "server.js"), serverCode);
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  }
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  Object.assign(env, { LITE_CCSWITCH_NODE: process.execPath, LITE_CCSWITCH_PORT: String(port), LITE_CCSWITCH_LOG: path.join(sandbox, "restart.log") });
  const child = spawn(process.execPath, ["server.js"], { cwd: foreign ? other : root, env, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("close", resolve));
  let replacement = null;
  t.after(async () => {
    if (replacement) {
      try { process.kill(replacement, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await rm(sandbox, { recursive: true, force: true });
  });
  const status = async () => fetch(`http://127.0.0.1:${port}/api/status`).then((response) => response.json());
  for (let i = 0; ; i += 1) {
    try { if ((await status()).processId === child.pid) break; } catch { /* 等待自建服务。 */ }
    if (i >= 200) throw new Error("自建重启测试服务未就绪");
    await pause(25);
  }
  return {
    child, status,
    async restart() {
      try { return await execute("bash", [path.join(root, "restart.sh"), String(port)], { cwd: sandbox, env, timeout: 15000 }); }
      finally {
        const current = await status().catch(() => null);
        if (current && current.processId !== child.pid) replacement = current.processId;
      }
    },
  };
}

test("npm 风格的相对路径服务能够由自己的重启脚本替换", { timeout: 30000 }, async (t) => {
  const current = await fixture(t, false);
  const result = await current.restart();
  assert.match(result.stdout, /已优雅重启/);
  assert.notEqual((await current.status()).processId, current.child.pid);
});

test("另一目录的同名相对路径服务不会被误停", { timeout: 30000 }, async (t) => {
  const foreign = await fixture(t, true);
  await assert.rejects(foreign.restart(), (error) => error.code === 1 && /非当前项目/.test(error.stderr));
  assert.equal((await foreign.status()).processId, foreign.child.pid);
});
