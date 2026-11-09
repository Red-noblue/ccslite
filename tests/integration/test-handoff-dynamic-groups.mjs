/**
 * 中文动态分组交接演练：真实 Lite 验证新增、复制、启停、换端口、冲突与落盘失败，以及变更后的版本回退。
 * 只使用独立版本、数据、端口和本机假上游；不访问正式服务，不发起真实计费请求。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandoffSupervisor } from "../../lib/handoff-supervisor.js";
import { createReleaseSnapshot } from "../../lib/release-snapshot.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error("等待动态分组交接超时");
}
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  assert.ok(server.address().port >= 15725); return server.address().port;
}
async function reserve() { const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }

test("动态分组端口由固定监听层持有，故障和版本回退保持配置与用量", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-handoff-dynamic-")); const data = path.join(root, "data"); await mkdir(data);
  const candidate = path.join(root, "candidate"); const fallback = path.join(root, "fallback");
  await createReleaseSnapshot(ROOT, candidate, "dynamic-candidate"); await createReleaseSnapshot(ROOT, fallback, "dynamic-fallback");
  let calls = 0; let finish = () => {}; let releaseGroup = () => {}; let supervisor;
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); calls += 1;
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.stream) {
      const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write(event("response.output_text.delta", { delta: "开始" }));
      const timer = setInterval(() => res.write(event("response.output_text.delta", { delta: "继续" })), 50); res.once("close", () => clearInterval(timer));
      finish = () => { clearInterval(timer); if (!res.destroyed) res.end(event("response.completed", { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })); };
    } else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}'); }
  });
  const blocked = createServer();
  t.after(async () => {
    releaseGroup(); finish(); await supervisor?.close(); upstream.closeAllConnections(); blocked.closeAllConnections();
    await Promise.all([new Promise((resolve) => upstream.close(resolve)), new Promise((resolve) => blocked.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  const upstreamPort = await listen(upstream); let publicPort; let blockedPort;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    publicPort = await reserve(); if (publicPort === 65535) continue;
    try { blockedPort = await listen(blocked, publicPort + 1); break; } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  }
  assert.equal(blockedPort, publicPort + 1, "明确占用自动分配的首个公开端口");
  const qualityPort = await reserve(); let movedPort = await reserve();
  await writeFile(path.join(data, "config.json"), JSON.stringify({ version: 2, proxy: { autoFailoverEnabled: false },
    providers: [{ id: "local", name: "本机假上游", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fake" }],
    groups: [{ id: "default", routingVersion: 1, name: "默认", listener: { host: "127.0.0.1", port: publicPort, enabled: true }, providerRefs: [{ providerId: "local", enabled: true, sortIndex: 1 }] }],
    connectivityTest: { periodicIntervalMs: null } }));
  await writeFile(path.join(data, "usage.jsonl"), "");
  const events = []; let crashOnCommit = false;
  supervisor = await createHandoffSupervisor({ candidate, fallback, dataDir: data, publicPort, observeMs: 60000, log: (line) => {
    events.push(line);
    if (crashOnCommit && line.includes('"event":"handoff_group_commit_started"')) { crashOnCommit = false; supervisor.current().child.kill("SIGKILL"); }
  } }); await supervisor.start();
  const api = async (endpoint, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${publicPort}${endpoint}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json(); return { status: response.status, payload };
  };
  const request = async (port, stream = false) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake", input: "local", stream }) });
    assert.equal(response.status, 200); return response;
  };
  const assertPublic = (group, port, enabled = true) => {
    assert.equal(group.listener.port, port); assert.equal(group.listenerStatus, enabled ? "listening" : "not_listening");
    assert.equal(group.actualListener?.port || null, enabled ? port : null);
  };
  const created = await api("/api/groups", "POST", { name: "高质量", sourceGroupId: "default", listener: { host: "127.0.0.1", port: qualityPort, enabled: true } });
  assert.equal(created.status, 201); assertPublic(created.payload, qualityPort);
  const qualityId = created.payload.id; assert.equal(created.payload.statistics.totalRequests, 0);
  assert.deepEqual(created.payload.providerRefs.map((ref) => ref.providerId), ["local"]);
  assert.notEqual(supervisor.current().groups[qualityId], qualityPort, "工作进程不能直接使用公开分组端口");
  await (await request(qualityPort)).text();
  const held = await request(qualityPort, true); const heldText = held.text();
  const moved = await api(`/api/groups/${qualityId}`, "PUT", { listener: { port: movedPort } }); assert.equal(moved.status, 200); assertPublic(moved.payload, movedPort);
  await (await request(movedPort)).text(); finish(); assert.match(await heldText, /response.completed/);
  await until(async () => !(await api("/api/status")).payload.handoff.pendingRequests);
  const beforeConflict = await readFile(path.join(data, "config.json"), "utf8");
  const conflict = await api(`/api/groups/${qualityId}`, "PUT", { listener: { port: blockedPort } }); assert.equal(conflict.status, 409);
  assert.equal(await readFile(path.join(data, "config.json"), "utf8"), beforeConflict);
  assertPublic((await api(`/api/groups/${qualityId}`)).payload, movedPort); await (await request(movedPort)).text();
  const disabled = await api(`/api/groups/${qualityId}`, "PUT", { listener: { enabled: false } }); assert.equal(disabled.status, 200); assertPublic(disabled.payload, movedPort, false);
  await assert.rejects(fetch(`http://127.0.0.1:${movedPort}/v1/responses`, { signal: AbortSignal.timeout(1000) }));
  const enabled = await api(`/api/groups/${qualityId}`, "PUT", { listener: { enabled: true } }); assert.equal(enabled.status, 200); assertPublic(enabled.payload, movedPort);
  await (await request(movedPort)).text();
  // 故障注入发生在公开端口预留之后，保证真正验证配置落盘失败，而非准备阶段读取失败。
  const applyGroup = supervisor.listener.applyGroup.bind(supervisor.listener); let failWrite = true;
  const failurePort = await reserve(); const configPath = path.join(data, "config.json"); const savedPath = path.join(data, "config.saved.json");
  supervisor.listener.applyGroup = async (group) => {
    await applyGroup(group);
    if (failWrite && group.id === qualityId && group.listener.port === failurePort) {
      failWrite = false;
      await assert.rejects(supervisor.upgrade(fallback), /交接/);
      await assert.rejects(supervisor.rollback("人工回退"), /交接/);
      await rename(configPath, savedPath); await mkdir(configPath);
    }
  };
  const failed = await api(`/api/groups/${qualityId}`, "PUT", { listener: { port: failurePort } });
  assert.equal(failed.status, 500);
  await rm(configPath, { recursive: true }); await rename(savedPath, configPath); supervisor.listener.applyGroup = applyGroup;
  assertPublic((await api(`/api/groups/${qualityId}`)).payload, movedPort); await (await request(movedPort)).text();
  // 保持一次端口变更的准备阶段，直接向私有进程补入另一条已接收的管理写入，验证其不会被旧快照覆盖。
  const concurrentPort = await reserve(); let entered = false; let privateFinished = false;
  const gate = new Promise((resolve) => { releaseGroup = resolve; });
  supervisor.listener.applyGroup = async (group) => { await applyGroup(group); if (group.id === qualityId && group.listener.port === concurrentPort) { entered = true; await gate; } };
  const moving = api(`/api/groups/${qualityId}`, "PUT", { name: "并发更名", listener: { port: concurrentPort } });
  await until(() => entered);
  const privateChange = fetch(`http://127.0.0.1:${supervisor.current().mainPort}/api/groups/${qualityId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: '{"description":"并发说明"}' }).then(async (response) => { await response.text(); privateFinished = true; return response.status; });
  await pause(50); assert.equal(privateFinished, false, "第二条管理写入必须等待前一条端口变更提交");
  releaseGroup(); assert.equal((await moving).status, 200); assert.equal(await privateChange, 200); supervisor.listener.applyGroup = applyGroup; movedPort = concurrentPort;
  const concurrent = (await api(`/api/groups/${qualityId}`)).payload;
  assert.equal(concurrent.name, "并发更名"); assert.equal(concurrent.description, "并发说明"); assertPublic(concurrent, movedPort);
  const cloned = await api(`/api/groups/${qualityId}/clone`, "POST"); assert.equal(cloned.status, 201); assertPublic(cloned.payload, cloned.payload.listener.port);
  assert.equal(cloned.payload.statistics.totalRequests, 0); assert.deepEqual(cloned.payload.providerRefs.map((ref) => ref.providerId), ["local"]);
  const cloneId = cloned.payload.id; const clonePort = cloned.payload.listener.port;
  assert.ok(clonePort > blockedPort && clonePort !== movedPort); await (await request(clonePort)).text();
  await supervisor.upgrade(fallback);
  await (await request(movedPort)).text(); await (await request(clonePort)).text();
  const latePort = await reserve();
  const late = await api("/api/groups", "POST", { name: "候选接管后新增", sourceGroupId: "default", listener: { host: "127.0.0.1", port: latePort, enabled: true } });
  assert.equal(late.status, 201); assertPublic(late.payload, latePort);
  await (await request(latePort)).text();
  await until(async () => !(await api("/api/status")).payload.handoff.pendingRequests);
  const committedPort = await reserve(); crashOnCommit = true;
  const interrupted = await api("/api/groups", "POST", { name: "落盘后崩溃", sourceGroupId: "default", listener: { host: "127.0.0.1", port: committedPort, enabled: true } });
  assert.equal(interrupted.status, 502);
  await until(() => supervisor.current().id === "dynamic-fallback" && supervisor.state().operation === null);
  for (const port of [movedPort, clonePort, latePort, committedPort]) await (await request(port)).text();
  const final = (await api("/api/status")).payload;
  for (const [id, port] of [[qualityId, movedPort], [cloneId, clonePort], [late.payload.id, latePort]]) assertPublic(final.groups.find((group) => group.id === id), port);
  await until(async () => (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).length === calls);
  const records = (await readFile(path.join(data, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const committedGroup = final.groups.find((group) => group.name === "落盘后崩溃"); assertPublic(committedGroup, committedPort);
  assert.equal(calls, 14); assert.equal(records.length, 14); assert.ok(records.every((item) => item.statusCode === 200));
  assert.ok(events.some((line) => line.includes('"event":"handoff_group_aborted"')));
  t.diagnostic(JSON.stringify({ newGroup: qualityId, clone: cloneId, sseDuringPortMove: true, conflictKeptConfig: true, writeFailureRestored: true, concurrentSettingsPreserved: true, crashAfterConfigCommitRecovered: true, recoveredLateGroup: true, calls, records: records.length }));
});
