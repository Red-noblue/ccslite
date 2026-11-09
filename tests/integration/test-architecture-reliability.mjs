/**
 * 中文架构验收：隔离数据、随机本机端口和模拟上游，验证配置失败、恢复迁移与跨分组在线交接。
 * 不读取生产密钥，不访问生产端口，不向真实供应商发送请求。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";
import { responseContextScope } from "../../lib/handoff-session.js";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server.address().port; }
async function reserve() { const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await pause(25); } throw new Error("架构验收等待超时"); }

test("配置失败保持旧状态，恢复后的旧响应在多分组逐步升级后仍选择正确供应商", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-architecture-")); const data = path.join(root, "data"); await mkdir(data);
  const next = path.join(root, "next"); await createReleaseSnapshot(ROOT, next, "architecture-next");
  const calls = []; let releaseHold = () => {}; let supervisor;
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const provider = req.headers.authorization === "Bearer a" ? "a" : "b";
    calls.push({ provider, input: body.input });
    const response = { id: body.input === "create" ? "shared-old-response" : `response-${body.input}`, model: body.model, status: "completed", usage: { input_tokens: 1, output_tokens: 1 } };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: response.id, status: "in_progress" } })}\n\n`);
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"保持连接"}\n\n');
      releaseHold = () => res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`); return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response));
  });
  const upstreamPort = await listen(upstream); const port = await reserve(); const groupPort = await reserve();
  const refs = [{ providerId: "a", enabled: false, sortIndex: 1 }, { providerId: "b", enabled: true, sortIndex: 2 }];
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: true },
    providers: ["a", "b"].map((id, index) => ({ id, name: id, apiKey: id, baseUrl: `http://127.0.0.1:${upstreamPort}`, routingEnabled: id === "b", sortIndex: index + 1 })),
    groups: ["default", "other"].map((id) => ({ id, name: id, routingVersion: 1, listener: { host: "127.0.0.1", port: id === "default" ? port : groupPort, enabled: true }, providerRefs: refs })),
    connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  t.after(async () => { releaseHold(); await supervisor?.close().catch(() => {}); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  supervisor = await createHandoffSupervisor({ candidate: ROOT, workspaceCandidate: true, fallback: next, dataDir: data, publicPort: port, observeMs: 60000, log: () => {} });
  await supervisor.start();
  const api = async (url, body) => { const response = await fetch(`http://127.0.0.1:${port}${url}`, { method: body ? "PUT" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, data: await response.json() }; };
  const request = async (targetPort, input, options = {}, session = "same-client-session") => {
    const response = await fetch(`http://127.0.0.1:${targetPort}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": session, "x-request-id": "same-id-across-groups" }, body: JSON.stringify({ model: "fake", input, ...options }) });
    assert.equal(response.status, 200, `请求 ${input} 应成功`); return response;
  };
  const before = (await api("/api/config")).data;
  const file = path.join(data, "config.json"); const saved = file + ".test-saved";
  await rename(file, saved); await mkdir(file);
  const failed = await api("/api/config", { proxy: { maxAttempts: 7 }, ui: { palette: "forest" } });
  assert.equal(failed.status, 500);
  const unchanged = (await api("/api/config")).data;
  assert.equal(unchanged.proxy.maxAttempts, before.proxy.maxAttempts); assert.equal(unchanged.ui.palette, before.ui.palette);
  await rm(file, { recursive: true }); await rename(saved, file);
  const concurrent = await Promise.all([api("/api/config", { proxy: { maxAttempts: 7 } }), api("/api/config", { ui: { groupThemeEnabled: false } })]);
  assert.ok(concurrent.every((item) => item.status === 200));
  const committed = JSON.parse(await readFile(file, "utf8")); assert.equal(committed.proxy.maxAttempts, 7); assert.equal(committed.ui.groupThemeEnabled, false);
  await (await request(port, "create")).json(); await (await request(groupPort, "create")).json();
  const scope = responseContextScope("default", "cct", "fake"); const otherScope = responseContextScope("other", "cct", "fake");
  await until(() => supervisor.listener.resolveResponseContext("shared-old-response", "fake", otherScope));
  assert.equal((await api("/api/groups/default", { providerRefs: refs.map((ref) => ({ ...ref, enabled: true })) })).status, 200);
  await (await request(port, "recover-1", {}, "fresh-1")).json(); await (await request(port, "recover-2", {}, "fresh-2")).json();
  await until(() => supervisor.listener.resolveResponseContext("shared-old-response", "fake", scope)?.providerId === "a");
  assert.deepEqual(supervisor.listener.resolveResponseContext("shared-old-response", "fake", scope), { providerId: "a", fallbackProviderIds: ["b"] });
  assert.equal(supervisor.listener.resolveResponseContext("shared-old-response", "fake", otherScope).providerId, "b");
  const held = await request(groupPort, "hold", { stream: true }); const heldText = held.text();
  const upgrade = supervisor.upgradeSession(next);
  await until(() => supervisor.state().phase === "active_parallel");
  assert.equal(supervisor.listener.sessionState().legacySessionCount, 1, "另一分组长请求不能拖住默认组的同名会话");
  await (await request(port, "continued", { previous_response_id: "shared-old-response" })).json();
  assert.equal(calls.find((item) => item.input === "continued").provider, "a");
  releaseHold(); assert.match(await heldText, /response.completed/); await upgrade;
  await until(() => supervisor.listener.sessionState().legacySessionCount === 0);
  await (await request(groupPort, "other-continued", { previous_response_id: "shared-old-response" })).json();
  assert.equal(calls.find((item) => item.input === "other-continued").provider, "b");
});
