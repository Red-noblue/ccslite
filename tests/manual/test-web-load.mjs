/** 中文真实浏览器验收：隔离启动管理台和 Chrome，检查按页取数、翻页及浏览器异常；只使用模拟用量。 */
import { createDevelopmentProvider } from "../helpers/development-provider.mjs";
import { createCompatibilityReports } from "../../lib/compatibility-reports.js";
import { createRecoveryEvidence } from "../../lib/recovery-evidence.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "undici";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { try { const result = await check(); if (result) return result; } catch {} await pause(50); } throw new Error("浏览器验收等待超时"); }
const root = await mkdtemp(path.join(os.tmpdir(), "lite-web-check-")); let child; let browser; let socket; let upstream;
try {
  let marker; let holdDevelopment = false; let releaseDevelopment; let upstreamRequests = 0; const development = createDevelopmentProvider();
  let releaseActivity;
  upstream = createServer(async (req, res) => {
    upstreamRequests += 1;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.input === "hold-session-id") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"test"}\n\n');
      await new Promise((resolve) => { releaseActivity = resolve; res.once("close", resolve); });
      if (!res.destroyed) res.end('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
      return;
    }
    if (body.tool_choice === "auto") {
      const output = development.respond(body);
      if (holdDevelopment) { await new Promise(resolve => { releaseDevelopment = resolve; }); if (res.destroyed) return; }
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(development.stream(body, output)); return;
    }
    let text = "CCOK"; let output;
    if (body.tool_choice?.name) output = [{ type: "function_call", name: "ccslite_compat_ping", call_id: "call-browser", arguments: "{}" }];
    if (body.tool_choice === "none") text = body.input.find((item) => item.type === "function_call_output").output;
    if (body.store && !body.previous_response_id) { marker = body.input[0].content[0].text.match(/CTX_[a-f0-9]+/)[0]; text = "OK"; }
    if (body.previous_response_id) text = marker;
    const response = { id: "resp-browser", model: body.model, status: "completed", output: output || [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1, output_tokens: 1 } };
    if (body.stream === false) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response)); }
    else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`); }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const reservation = createServer(); await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const data = path.join(root, "data"); const profile = path.join(root, "chrome"); await mkdir(data); await mkdir(profile);
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, providers: [{ id: "fake", name: "浏览器模拟供应商", baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "test-only", routingEnabled: true }], groups: [{ id: "browser-review", name: "复核分组", listener: { enabled: false, port: 15725 } }], connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), Array.from({ length: 95 }, (_, n) => JSON.stringify({ id: `r-${n}`, groupId: "default", providerId: "fake", providerName: "浏览器模拟供应商", timestamp: new Date().toISOString(), statusCode: 200, inputTokens: 2, outputTokens: 3, totalTokens: 5, routeReason: n % 2 ? "failover" : "", routeSnapshot: n % 2 ? { version: 1, mode: "auto", routeKey: "cct", model: "mock-model", candidates: [{ providerId: "fake", providerName: "浏览器模拟供应商", priority: 1 }], excluded: [{ providerId: "off", providerName: "已关闭模拟供应商", reason: "routing_disabled" }] } : null, providerAttempts: n % 2 ? [{ providerId: "fake", providerName: "浏览器模拟供应商", outcome: "failure", statusCode: 200, failureClass: "stream_protocol", streamDiagnostics: { outputStarted: true, forwardedBytes: 15, termination: "upstream_eof", events: { completed: false } } }] : [] })).join("\n") + "\n");
  const reportStore = createCompatibilityReports(data);
  const fixtureFingerprint = "a".repeat(64);
  for (let n = 0; n < 11; n++) await reportStore.save({ providerId: "fake", groupId: "default", model: n ? "历史模型" : "mock-model", mode: n ? "basic" : "development", checkedAt: new Date().toISOString(), requestCount: 5, outcome: "passed", configFingerprint: n ? "old" : fixtureFingerprint, results: [], usage: { totalTokens: 0 } });
  const recoveryStore = createRecoveryEvidence(data);
  const recovery = { groupId: "default", providerId: "fake", providerName: "浏览器模拟供应商", model: "mock-model", confirmationId: "browser-fixture", source: "probe", successCount: 2 };
  const confirmationEventId = recoveryStore.record({ ...recovery, kind: "confirmed" });
  const migrationEventId = recoveryStore.record({ ...recovery, kind: "bindings_migrated", migratedBindings: 1 });
  recoveryStore.record({ ...recovery, kind: "invalidated", reason: "failure_or_configuration" });
  await recoveryStore.flush();
  const fixtureRecords = (await readFile(path.join(data, "usage.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const diagnosticFixture = fixtureRecords.find((record) => record.id === "r-93");
  diagnosticFixture.isStreaming = true;
  Object.assign(diagnosticFixture.providerAttempts[0].streamDiagnostics, {
    firstByteLatencyMs: 13920,
    lastChunkAt: new Date().toISOString(),
  });
  const fixture = fixtureRecords.find((record) => record.id === "r-91");
  fixture.requestStartedAt = new Date().toISOString(); fixture.requestModel = "mock-model";
  fixture.routeSnapshot.recovery = { confirmationEventId, migrationEventId, providerId: "fake", confirmedAt: fixture.requestStartedAt };
  fixture.providerAttempts = [{ providerId: "fake", providerName: "浏览器模拟供应商", outcome: "success", statusCode: 200, configFingerprint: fixtureFingerprint }];
  await writeFile(path.join(data, "usage.jsonl"), fixtureRecords.map(JSON.stringify).join("\n") + "\n");
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
  const downloads = path.join(root, "downloads"); await mkdir(downloads);
  await command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: base });
  await command("Page.bringToFront");
  await until(() => evaluate('document.body.innerText.includes("浏览器模拟供应商")'));
  // 浮层不能改变指标卡和供应商列表的位置，窄屏下也不能裁掉浮层或指标。
  await until(() => evaluate('Boolean(document.querySelector(".stream-diagnostics-trigger"))'));
  const measureOverview = () => evaluate(`(() => {
    const view = document.querySelector(".cc-view-scroll");
    const grid = document.querySelector(".metric-grid.compact");
    const card = document.querySelector(".provider-activity-card");
    const bounds = (element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return [left, top, right, bottom].map(Math.round);
    };
    return {
      view: bounds(view),
      grid: bounds(grid),
      tiles: bounds(document.querySelector(".metric-card-group")),
      card: bounds(card),
      toolbar: bounds(document.querySelector(".provider-list-toolbar")),
      overflows: grid.scrollWidth > grid.clientWidth + 1,
    };
  })()`);
  for (const width of [1440, 1100, 900, 390, 320]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 960, deviceScaleFactor: 1, mobile: false });
    await pause(350);
    const collapsed = await measureOverview();
    assert.equal(await evaluate('document.querySelectorAll(".metric-card-group .metric-card").length'), 8);
    if (width > 760) {
      assert.ok(collapsed.tiles[2] - collapsed.tiles[0] <= 620);
      assert.ok(collapsed.tiles[2] < collapsed.card[0]);
    } else {
      assert.equal(collapsed.card[0], collapsed.tiles[0]);
      assert.ok(collapsed.card[1] >= collapsed.tiles[3]);
    }
    await evaluate('document.querySelector(".stream-diagnostics-trigger").click()');
    assert.equal(await evaluate('document.querySelector(".provider-activity-diagnostics").matches(":popover-open")'), true);
    const expanded = await measureOverview();
    assert.deepEqual(expanded, collapsed, `${width}px 展开流式诊断不应移动顶部卡片或供应商工具栏`);
    assert.equal(expanded.overflows, false, `${width}px 指标卡片不应横向溢出`);
    const diagnosticsText = await evaluate('document.querySelector(".provider-activity-diagnostics").innerText');
    assert.match(diagnosticsText, /回复已开始，中途失败\s+1 次/);
    assert.match(diagnosticsText, /13\.9 秒/);
    assert.doesNotMatch(diagnosticsText, /上游传输错误/);
    await evaluate('document.querySelector(".stream-diagnostics-detail summary").click()');
    const detail = await evaluate('document.querySelector(".stream-diagnostics-detail").innerText');
    assert.match(detail, /最近记录到的上游数据/);
    assert.match(detail, /同一请求可能尝试多次/);
    assert.deepEqual(await measureOverview(), collapsed, `${width}px 展开原因说明也不应移动卡片`);
    const popup = await evaluate(`(() => {
      const panel = document.querySelector(".provider-activity-diagnostics");
      const { left, top, right, bottom } = panel.getBoundingClientRect();
      return { left, top, right, bottom, inViewport: left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight };
    })()`);
    assert.ok(popup.inViewport, `${width}px 浮层超出视口：${JSON.stringify(popup)}`);
    await evaluate('document.querySelector(".stream-diagnostics-detail summary").click()');
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await until(() => evaluate('!document.querySelector(".provider-activity-diagnostics").matches(":popover-open")'));
  }
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await pause(6200);
  assert.equal(requests.filter((url) => url.startsWith("/api/billing/logs")).length, 0, "供应商页面不应下载日志");
  assert.equal(requests.filter((url) => url.startsWith("/api/diagnostics")).length, 0, "供应商页面不应下载诊断");
  const providerRequests = [...requests]; requests.length = 0;
  const screenshot = async (name) => {
    if (!process.env.LITE_TEST_SCREENSHOT_DIR) return;
    await mkdir(process.env.LITE_TEST_SCREENSHOT_DIR, { recursive: true });
    const result = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(process.env.LITE_TEST_SCREENSHOT_DIR, name + ".png"), Buffer.from(result.data, "base64"));
  };
  const openPanel = async () => {
    await evaluate('(() => { const trigger = document.querySelector("button[title=编码兼容性检查]"); trigger.focus(); trigger.click(); })()');
    await until(() => evaluate('Boolean(document.querySelector(".compatibility-dialog[open]"))'));
  };
  const switchTab = async (label) => evaluate(`Array.from(document.querySelectorAll(".compatibility-tabs button")).find(button => button.textContent.includes(${JSON.stringify(label)})).click()`);
  const begin = async () => evaluate('document.querySelector(".compatibility-start").click()');
  const choose = async (mode) => evaluate(`document.querySelector('input[type=radio][value="${mode}"]').click()`);
  const checkLayout = async () => {
    const dimensions = await evaluate('(() => { const dialog = document.querySelector(".compatibility-dialog"); const body = document.querySelector(".compatibility-body"); const rect=dialog.getBoundingClientRect(); return { modal: dialog.matches(":modal"), outsideCard:dialog.parentElement===document.body, x:rect.x, y:rect.y, right:rect.right, bottom:rect.bottom, viewportWidth:innerWidth, viewportHeight:innerHeight, overflow:body.scrollWidth>body.clientWidth+1 }; })()');
    assert.equal(dimensions.modal, true); assert.equal(dimensions.outsideCard, true); assert.equal(dimensions.overflow, false);
    assert.ok(dimensions.x >= 0 && dimensions.y >= 0 && dimensions.right <= dimensions.viewportWidth + 1 && dimensions.bottom <= dimensions.viewportHeight + 1, JSON.stringify(dimensions));
    return dimensions;
  };
  const cardHeight = await evaluate('document.querySelector(".cc-provider-card").getBoundingClientRect().height');
  await openPanel();
  assert.equal(await evaluate('document.querySelector(".cc-provider-card").getBoundingClientRect().height'), cardHeight, "弹窗不能撑高供应商卡片");
  assert.match(await evaluate('document.querySelector(".compatibility-panel").innerText'), /可能产生少量费用/);
  assert.equal(await evaluate('document.querySelectorAll(".compatibility-panel button[type=submit]").length'), 1);
  assert.equal(await evaluate('document.querySelector(".compatibility-details").open'), false);
  assert.equal(await evaluate('document.activeElement === document.querySelector(".compatibility-model-row input")'), true);
  await checkLayout(); await screenshot("desktop-initial");
  // Escape 关闭并回到触发按钮，重新打开仍可使用。
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await until(() => evaluate('!document.querySelector(".compatibility-dialog")'));
  assert.equal(await evaluate('document.activeElement === document.querySelector("button[title=编码兼容性检查]")'), true);
  await openPanel();
  await choose("basic"); await begin();
  await until(() => evaluate('document.querySelector(".compatibility-result")?.innerText.includes("已发起 5 次请求")'));
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".compatibility-checklist li strong")).filter(item => item.textContent.endsWith("：通过")).length'), 3);
  assert.match(await evaluate('document.querySelector(".compatibility-report-scope").innerText'), /检查定义 v1/);
  await switchTab("历史报告");
  await until(() => evaluate('document.querySelector(".compatibility-history").innerText.includes("共 12 份")'));
  await evaluate('Array.from(document.querySelectorAll(".compatibility-panel button")).find(button => button.textContent === "下一页").click()');
  await until(() => evaluate('document.querySelector(".compatibility-panel").innerText.includes("第 2 页")'));
  await evaluate('Array.from(document.querySelectorAll(".compatibility-history-list button")).find(button => button.textContent.includes("历史模型")).click()');
  await until(() => evaluate('document.querySelector(".compatibility-result").innerText.includes("配置已变化")'));
  assert.match(await evaluate('document.querySelector(".compatibility-report-scope").innerText'), /历史报告未记录检查定义版本/);
  await switchTab("开始检查");
  await choose("development"); await begin();
  await until(() => evaluate('document.querySelector(".compatibility-result")?.innerText.includes("开发任务：通过")'));
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".compatibility-checklist li strong")).filter(item => item.textContent.endsWith("：通过")).length'), 6);
  assert.equal(development.requests.length, 4);
  const requestsBeforeDownload = upstreamRequests;
  await evaluate('document.querySelector(".compatibility-export").click()');
  const downloadName = await until(async () => (await readdir(downloads)).find(name => name.endsWith(".json")));
  const exported = JSON.parse(await readFile(path.join(downloads, downloadName), "utf8"));
  assert.equal(exported.format, "ccslite-readiness-report"); assert.equal(exported.readiness, "verified_for_this_task");
  assert.equal(exported.definition.version, 1); assert.equal(exported.environment.nodeVersion, process.version);
  assert.doesNotMatch(JSON.stringify(exported), /test-only|浏览器模拟供应商|127\.0\.0\.1|configFingerprint|providerId/);
  const exportExtraUpstreamRequests = upstreamRequests - requestsBeforeDownload;
  assert.equal(exportExtraUpstreamRequests, 0, "浏览器导出不得重复检查供应商");
  await evaluate('document.querySelector(".compatibility-report-scope").open = true');
  await evaluate('document.querySelector(".compatibility-result").scrollIntoView({block:"start"})');
  await pause(300); await checkLayout(); await screenshot("desktop-result");
  assert.equal(await evaluate('document.querySelector(".compatibility-evidence").open'), true);
  assert.equal(await evaluate('document.querySelectorAll(".compatibility-round").length'), 4);
  assert.equal(await evaluate('document.querySelectorAll(".compatibility-tool-step").length'), 6);
  assert.match(await evaluate('document.querySelector(".compatibility-evidence").innerText'), /SSE 流式.*HTTP 200/);
  assert.match(await evaluate('document.querySelector(".compatibility-evidence").innerText'), /node task-check.mjs verify/);
  await command("Page.reload");
  await until(() => evaluate('Boolean(document.querySelector("button[title=编码兼容性检查]"))'));
  await openPanel(); await switchTab("历史报告");
  await until(() => evaluate('Array.from(document.querySelectorAll(".compatibility-history-list button")).some(button => button.textContent.includes("开发任务 ·") && button.textContent.includes("通过"))'));
  await checkLayout(); await screenshot("desktop-history");
  await evaluate('Array.from(document.querySelectorAll(".compatibility-history-list button")).find(button => button.textContent.includes("开发任务 ·") && button.textContent.includes("通过")).click()');
  await until(() => evaluate('document.querySelector(".compatibility-result")?.innerText.includes("开发任务：通过")'));
  await switchTab("开始检查");
  holdDevelopment = true; await begin();
  await until(async () => Boolean(releaseDevelopment));
  assert.equal(await evaluate('document.querySelector("button[aria-label=关闭兼容性检查]").disabled'), true);
  for (let attempt = 0; attempt < 3; attempt++) {
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  assert.equal(await evaluate('Boolean(document.querySelector(".compatibility-dialog[open]"))'), true, "Escape 不应意外取消计费检查");
  await checkLayout(); await screenshot("desktop-running");
  await evaluate('Array.from(document.querySelectorAll(".compatibility-panel button")).find(button => button.textContent === "取消检查").click()');
  await until(() => evaluate('document.querySelector(".compatibility-panel").innerText.includes("已请求取消")'));
  holdDevelopment = false; releaseDevelopment();
  await until(async () => (await reportStore.list("default", "fake")).reports.some(item => item.outcome === "cancelled"));
  // 手机宽度检查：对话框与内部内容均不得横向溢出。
  const layouts = [];
  for (const width of [390, 320]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
    await pause(150); layouts.push(await checkLayout()); await screenshot(`mobile-${width}-initial`);
    await switchTab("历史报告"); layouts.push(await checkLayout()); await screenshot(`mobile-${width}-history`);
    await evaluate('document.querySelector(".compatibility-report-footer").scrollIntoView({block:"center"})');
    layouts.push(await checkLayout()); await screenshot(`mobile-${width}-export`);
    await switchTab("开始检查");
  }
  await command("Emulation.setDeviceMetricsOverride", { width:1280, height:960, deviceScaleFactor:1, mobile:false });
  await evaluate('document.querySelector("button[aria-label=关闭兼容性检查]").click()');
  await until(() => evaluate('!document.querySelector(".compatibility-dialog")'));
  console.log(JSON.stringify({ compatibilityLayouts: layouts, reportReloaded: true, cancellationProtected: true, sanitizedDownload: true, exportExtraUpstreamRequests }));

  // 无头浏览器在切换视口和关闭原生弹窗后可能进入后台，恢复可见性再验收按需轮询。
  await command("Page.bringToFront");
  await evaluate('document.querySelector("button[title=使用统计]").click()');
  await until(() => evaluate('Boolean(document.querySelector(".usage-dashboard")) && document.querySelectorAll(".usage-category-tag").length >= 0 && document.body.innerText.includes("共 105 条")'));
  assert.match(await evaluate('document.querySelector(".ccok-usage-card").innerText'), /探测统计/);
  assert.match(await evaluate('document.querySelector(".ccok-usage-card .state-pill").innerText'), /10 次/);
  const first = await evaluate('Array.from(document.querySelectorAll(".usage-dashboard .cc-table")).at(-1).querySelectorAll("tbody tr").length');
  assert.equal(first, 30);
  const diagnosticTexts = [];
  for (let row = 0; row < 2; row += 1) {
    await evaluate(`Array.from(document.querySelectorAll(".usage-log-row")).filter(row => row.textContent.includes("浏览器模拟供应商") && !row.textContent.includes("兼容检查"))[${row}].querySelector("button").click()`);
    await until(() => evaluate('Boolean(document.querySelector(".request-diagnostics"))'));
    diagnosticTexts.push(await evaluate('document.querySelector(".request-diagnostics").innerText'));
  }
  assert.ok(diagnosticTexts.some((text) => text.includes("当时未记录候选快照")));
  assert.ok(diagnosticTexts.some((text) => text.includes("未参与本组自动路由") && text.includes("不能拼接另一供应商")));
  const upstreamBeforeEvidence = upstreamRequests;
  await evaluate('Array.from(document.querySelectorAll(".request-evidence button")).find(button => button.textContent.includes("查看关联证据")).click()');
  await until(() => evaluate('document.querySelector(".request-evidence").innerText.includes("当时未记录配置摘要或时间")'));
  assert.equal(upstreamRequests, upstreamBeforeEvidence, "查看关联证据不会请求供应商");
  assert.match(await evaluate('document.querySelector(".request-explanation").innerText'), /这次请求发生了什么/);
  await screenshot("desktop-request-evidence");
  await evaluate('Array.from(document.querySelectorAll(".usage-log-row")).filter(row => row.textContent.includes("浏览器模拟供应商") && !row.textContent.includes("兼容检查"))[3].querySelector("button").click()');
  await until(() => evaluate('Boolean(document.querySelector(".request-diagnostics"))'));
  await evaluate('Array.from(document.querySelectorAll(".request-evidence button")).find(button => button.textContent.includes("查看关联证据")).click()');
  await until(() => evaluate('document.querySelector(".request-evidence").innerText.includes("已确认可用")'));
  const linkedEvidence = await evaluate('document.querySelector(".request-evidence").innerText');
  assert.match(linkedEvidence, /已迁移 1 个会话绑定/); assert.match(linkedEvidence, /已由当时确认恢复的供应商成功处理/);
  assert.match(linkedEvidence, /开发任务检查/); assert.doesNotMatch(linkedEvidence, /当时未记录配置摘要/);
  assert.equal(requests.filter((url) => url.startsWith("/api/routing/recovery-events")).length, 0, "恢复历史必须按需读取");
  await evaluate('document.querySelector(".recovery-history").open = true; document.querySelector(".recovery-history button").click()');
  await until(() => evaluate('document.querySelector(".recovery-history").innerText.includes("共 3 项")'));
  assert.match(await evaluate('document.querySelector(".recovery-history").innerText'), /恢复确认失效/);
  assert.equal(upstreamRequests, upstreamBeforeEvidence, "查看关联报告和恢复历史均不请求供应商");
  for (const width of [390, 320]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height:844, deviceScaleFactor:1, mobile:false });
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth + 1'), false, "请求证据不能横向溢出");
  }
  await command("Emulation.setDeviceMetricsOverride", { width:1280, height:960, deviceScaleFactor:1, mobile:false });
  await evaluate('document.querySelector(".request-evidence").scrollIntoView({block:"start"})');
  await pause(150);
  await screenshot("desktop-linked-evidence");
  await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim()==="2" && button.classList.contains("page-button")).click()');
  await until(() => evaluate('Boolean(document.querySelector(".page-button.active")?.textContent === "2")'));
  await until(() => requests.some((url) => url.includes("/api/billing/logs?") && url.includes("page=2") && url.includes("snapshot=")));
  await pause(1000); assert.equal(await evaluate('document.querySelectorAll(".request-diagnostics").length'), 0); assert.deepEqual(exceptions, []);
  // 沿真实 UI 路径提交和删除，保持同一页面与 EventSource 连接。
  await evaluate('document.querySelector(".brand-title").click()');
  await until(() => evaluate('Boolean(document.querySelector(".hero-strip button"))'));
  await evaluate('document.querySelector(".hero-strip button").click()');
  await until(() => evaluate('Boolean(document.querySelector(".add-panel form"))'));
  const fill = async (label, value) => evaluate(`(() => {
    const field = [...document.querySelectorAll(".add-panel form label")].find(el => el.firstElementChild?.textContent === ${JSON.stringify(label)});
    const input = field.querySelector("input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await fill("名称", "浏览器新增 P2");
  await fill("Base URL", `http://127.0.0.1:${upstream.address().port}`);
  await fill("API Key", "test-only");
  await fill("优先级", "2");
  await evaluate('document.querySelector(".add-panel form button[type=submit]").click()');
  await until(() => evaluate('document.querySelector(".notification-stack").innerText.includes("已添加供应商")'));
  await evaluate('document.querySelector(".brand-title").click()');
  const addedCard = '[...document.querySelectorAll(".cc-provider-card")].find(card => card.querySelector("h3")?.textContent === "浏览器新增 P2")';
  await until(() => evaluate(`Boolean(${addedCard})`));
  assert.equal(await evaluate(`(${addedCard}).querySelector(".priority-badge").textContent`), "P2");
  await evaluate(`(${addedCard}).querySelector("button[title^=CCOK]").click()`);
  await until(() => evaluate('document.querySelector(".notification-stack").innerText.includes("JSON 非流式")'));
  await until(() => evaluate(`(${addedCard}).querySelector(".provider-test-status")?.innerText.includes("检测成功")`));
  assert.match(await evaluate(`(${addedCard}).querySelector(".provider-test-status").innerText`), /请求 JSON（非流式）/);
  await evaluate(`window.confirm = () => true; (${addedCard}).querySelector("button[title=删除]").click();`);
  await until(() => evaluate(`!(${addedCard}) && document.querySelector(".notification-stack").innerText.includes("已删除供应商")`));
  await evaluate('document.querySelector(".notification-toast:last-child button").click()');
  assert.doesNotMatch(await evaluate('document.querySelector(".notification-stack").innerText'), /已删除供应商/);
  const browserSessionId = "019b0000-4444-7555-8666-777777777777";
  const heldActivity = fetch(base + "/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", originator: "codex_cli_rs", "thread-id": browserSessionId, "x-request-id": "browser-request" },
    body: JSON.stringify({ model: "mock-model", input: "hold-session-id", stream: true }),
  }).then((response) => response.text());
  await until(() => evaluate('Boolean(document.querySelector(".provider-live-session code"))'));
  assert.equal(await evaluate('document.querySelector(".provider-live-session code").textContent'), browserSessionId);
  assert.equal(await evaluate('document.querySelector(".provider-live-request small").textContent'), "请求 ID · browser-request");
  await command("Browser.grantPermissions", { origin: base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await evaluate('document.querySelector(".provider-live-copy").click()');
  await until(() => evaluate('document.querySelector(".provider-live-copy")?.title === "已复制"'));
  assert.equal(await evaluate('navigator.clipboard.readText()'), browserSessionId);
  await command("Emulation.setDeviceMetricsOverride", { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.querySelector(".provider-live-session").scrollWidth > document.querySelector(".provider-live-session").clientWidth + 1'), false);
  releaseActivity(); await heldActivity;
  await until(() => evaluate('!document.querySelector(".provider-live-session")'));

  // 验证页面内容和地址一致，并用浏览器历史及刷新恢复同一分组和子页。
  const waitRoute = (hash, selector) => until(() =>
    evaluate(`location.hash === ${JSON.stringify(hash)} && Boolean(document.querySelector(${JSON.stringify(selector)}))`));
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector("button[title=设置与分组管理]").click()');
  await waitRoute("#settings", ".settings-view");
  await evaluate('document.querySelector(\'.group-sidebar-button[href="#providers"]\').click()');
  await waitRoute("#providers", ".providers-view");
  await evaluate("history.back()");
  await waitRoute("#settings", ".settings-view");
  await evaluate("history.forward()");
  await waitRoute("#providers", ".providers-view");
  await evaluate('document.querySelector(\'.group-sidebar-button[href="#providers?group=browser-review"]\').click()');
  await waitRoute("#providers?group=browser-review", ".providers-view");
  await command("Page.reload");
  await waitRoute("#providers?group=browser-review", '.group-sidebar-button[aria-current="page"]');
  assert.match(await evaluate('document.querySelector(".group-current-line").innerText'), /复核分组/);
  await evaluate('document.querySelector(".hero-strip button").click()');
  await waitRoute("#add?group=browser-review", ".add-panel");
  await evaluate('document.querySelector("button[title=使用统计]").click()');
  await waitRoute("#billing?group=browser-review", ".usage-dashboard");
  await evaluate('document.querySelectorAll(".usage-section-tabs button")[1].click()');
  await waitRoute("#billing?group=browser-review&section=experiment", ".usage-section-tabs button:nth-child(2).active");
  await command("Page.reload");
  await waitRoute("#billing?group=browser-review&section=experiment", ".usage-section-tabs button:nth-child(2).active");
  await evaluate('document.querySelector("button[title=设置与分组管理]").click()');
  await waitRoute("#settings?group=browser-review", ".settings-view");
  await evaluate('Array.from(document.querySelectorAll(".header-settings-nav button")).find(button => button.textContent === "分组管理").click()');
  await waitRoute("#settings?group=browser-review&section=settings-groups", ".settings-view");
  await command("Page.reload");
  await waitRoute("#settings?group=browser-review&section=settings-groups", '.header-settings-nav button:nth-child(6)[aria-current="location"]');
  await command("Page.navigate", { url: base + "/#billing?provider=fake" });
  await until(() => evaluate('location.hash === "#billing?provider=fake" && document.querySelector(".usage-toolbar h2")?.textContent.includes("浏览器模拟供应商")'));
  await command("Page.navigate", { url: base + "/#providers?group=does-not-exist" });
  await waitRoute("#providers", '.group-sidebar-button[aria-current="page"]');
  assert.match(await evaluate('document.querySelector(".group-current-line").innerText'), /默认分组/);
  assert.equal(requests.some((url) => url.includes("groupId=does-not-exist")), false);
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ providerPageRequests: providerRequests, billingPageRequests: requests, rowsPerPage: first, consoleExceptions: exceptions }, null, 2));
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { const done = once(browser, "exit"); browser.kill("SIGTERM"); await done; }
  if (child && child.exitCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
  if (upstream) { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
