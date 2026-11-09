/** 中文真实浏览器验收：隔离启动管理台和 Chrome，检查分页和浏览器异常；可导出仅含模拟数据的项目预览截图。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "undici";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { try { const result = await check(); if (result) return result; } catch {} await pause(50); } throw new Error("浏览器验收等待超时"); }
const root = await mkdtemp(path.join(os.tmpdir(), "lite-web-check-")); let child; let browser; let socket;
try {
  const reservation = createServer(); await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const data = path.join(root, "data"); const profile = path.join(root, "chrome"); await mkdir(data); await mkdir(profile);
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, providers: [{ id: "fake", name: "浏览器模拟供应商", baseUrl: "http://127.0.0.1:1", apiKey: "test-only", routingEnabled: true }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), Array.from({ length: 95 }, (_, n) => JSON.stringify({ id: `r-${n}`, groupId: "default", providerId: "fake", providerName: "浏览器模拟供应商", timestamp: new Date().toISOString(), statusCode: 200, inputTokens: 2, outputTokens: 3, totalTokens: 5 })).join("\n") + "\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_")));
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env: { ...env, LITE_CCSWITCH_DATA_DIR: data, LITE_CCSWITCH_PORT: String(port), LITE_CCSWITCH_HOST: "127.0.0.1" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`; await until(async () => (await fetch(base + "/api/status")).ok);
  const chrome = process.env.LITE_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-proxy-server", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const debuggingPort = await until(async () => Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]));
  const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).then((r) => r.json());
  socket = new WebSocket(targets.find((item) => item.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0; const tasks = new Map(); const requests = []; const exceptions = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id && tasks.has(message.id)) { const task = tasks.get(message.id); tasks.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
    if (message.method === "Network.requestWillBeSent" && message.params.request.url.startsWith(base + "/api/")) requests.push(message.params.request.url.slice(base.length));
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text + ": " + message.params.exceptionDetails.exception?.description);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; const timer = setTimeout(() => { tasks.delete(requestId); reject(new Error(`CDP 超时：${method}`)); }, 10000); tasks.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
  await command("Network.enable"); await command("Runtime.enable"); await command("Page.enable");
  if (process.env.LITE_TEST_SCREENSHOT) await command("Emulation.setDeviceMetricsOverride", { width: 1100, height: 880, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: base });
  await until(() => evaluate('document.body.innerText.includes("浏览器模拟供应商")'));
  await pause(6200);
  if (process.env.LITE_TEST_SCREENSHOT) {
    const output = path.resolve(process.env.LITE_TEST_SCREENSHOT);
    await mkdir(path.dirname(output), { recursive: true });
    const capture = await command("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(output, Buffer.from(capture.data, "base64"));
  }
  assert.equal(requests.filter((url) => url.startsWith("/api/billing/logs")).length, 0, "供应商页面不应下载日志");
  assert.equal(requests.filter((url) => url.startsWith("/api/diagnostics")).length, 0, "供应商页面不应下载诊断");
  const providerRequests = [...requests]; requests.length = 0;
  await evaluate('document.querySelector("button[title=使用统计]").click()');
  await until(() => evaluate('Boolean(document.querySelector(".usage-dashboard")) && document.querySelectorAll(".usage-category-tag").length >= 0 && document.body.innerText.includes("共 95 条")'));
  const first = await evaluate('Array.from(document.querySelectorAll(".usage-dashboard .cc-table")).at(-1).querySelectorAll("tbody tr").length');
  assert.equal(first, 30);
  await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim()==="2" && button.classList.contains("page-button")).click()');
  await until(() => evaluate('Boolean(document.querySelector(".page-button.active")?.textContent === "2")'));
  await until(() => requests.some((url) => url.includes("/api/billing/logs?") && url.includes("page=2") && url.includes("snapshot=")));
  await pause(1000); assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ providerPageRequests: providerRequests, billingPageRequests: requests, rowsPerPage: first, consoleExceptions: exceptions }, null, 2));
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { const done = once(browser, "exit"); browser.kill("SIGTERM"); await done; }
  if (child && child.exitCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
  await rm(root, { recursive: true, force: true });
}
