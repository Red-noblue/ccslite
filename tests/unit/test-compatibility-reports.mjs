/** 报告持久化验收：并行独立写入、分页隔离、配置过期及软链接保护。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compatibilityFingerprint, createCompatibilityReports } from "../../lib/compatibility-reports.js";
const sample = { groupId: "default", providerId: "mock", mode: "development", model: "mock-model", checkedAt: new Date().toISOString(), requestCount: 4, outcome: "passed", results: [], steps: [], configFingerprint: "test-hash" };

test("新旧实例并行保存不可变报告，重建存储仍可分页读取且分组和供应商隔离", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "lite-compat-reports-"));
  try {
    const first = createCompatibilityReports(data), second = createCompatibilityReports(data);
    const reports = await Promise.all(Array.from({ length: 15 }, (_, n) => (n % 2 ? first : second).save({ ...sample, requestCount: n })));
    assert.equal(new Set(reports.map((item) => item.reportId)).size, 15);
    const reopened = createCompatibilityReports(data);
    const history = await reopened.list("default", "mock"); assert.equal(history.total, 15); assert.equal(history.reports.length, 10);
    assert.equal((await reopened.list("default", "mock", { page: 2 })).reports.length, 5);
    assert.equal((await reopened.list("other", "mock")).total, 0);
    assert.equal(await reopened.read("other", "mock", reports[0].reportId), null);
    assert.equal(await reopened.read("default", "other", reports[0].reportId), null);
    assert.equal(await reopened.read("default", "mock", "../../config"), null);
    assert.deepEqual(await reopened.read("default", "mock", reports[0].reportId), reports[0]);
    const groupDirs = await readdir(path.join(data, "compatibility-reports")); const groupDir = path.join(data, "compatibility-reports", groupDirs[0]);
    assert.equal((await stat(groupDir)).mode & 0o777, 0o700); assert.equal((await stat(path.join(groupDir, `${reports[0].reportId}.json`))).mode & 0o777, 0o600);
    assert.equal((await readdir(groupDir)).filter((name) => name.endsWith(".tmp")).length, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(groupDir, `${reports[0].reportId}.json`), "utf8")), reports[0]);
  } finally { await rm(data, { recursive: true, force: true }); }
});

test("报告根目录及分组目录软链接不能用于读写其他位置", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "lite-compat-links-"));
  try {
    const outside = path.join(data, "outside"); await mkdir(outside);
    await symlink(outside, path.join(data, "compatibility-reports"));
    const store = createCompatibilityReports(data); await assert.rejects(store.save(sample), /软链接/);
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(data, { recursive: true, force: true }); }
});

test("配置指纹只关心兼容性与认证，键顺序和路由、名称变化不使报告过期", async () => {
  const provider = { baseUrl: "https://example.invalid/v1", apiKey: "secret", authMode: "api_key", customHeaders: { b: "2", a: "1" }, modelMap: { alias: "model" } };
  const original = await compatibilityFingerprint(provider);
  assert.equal(await compatibilityFingerprint({ ...provider, name: "renamed", sortIndex: 9, routingEnabled: false, customHeaders: { a: "1", b: "2" } }), original);
  for (const patch of [{ apiKey: "new" }, { baseUrl: "https://other.invalid" }, { modelMap: { alias: "another" } }, { stripParams: ["tools"] }, { proxyUrl: "http://127.0.0.1:9" }]) assert.notEqual(await compatibilityFingerprint({ ...provider, ...patch }), original);
  assert.notEqual(await compatibilityFingerprint({ authMode: "client_session" }, { authorization: "a" }), await compatibilityFingerprint({ authMode: "client_session" }, { authorization: "b" }));
  assert.doesNotMatch(original, /secret|https:/);
  const data = await mkdtemp(path.join(tmpdir(), "lite-compat-auth-"));
  const previousOAuthHome = process.env.LITE_CCSWITCH_OAUTH_FILE_HOME;
  process.env.LITE_CCSWITCH_OAUTH_FILE_HOME = data;
  try {
    const oauthFilePath = path.join(data, "auth.json"); await writeFile(oauthFilePath, JSON.stringify({ tokens: { access_token: "private-auth", account_id: "account" } }));
    const first = await compatibilityFingerprint({ authMode: "oauth_file", oauthFilePath });
    const firstTilde = await compatibilityFingerprint({ authMode: "oauth_file", oauthFilePath: "~/auth.json" });
    await writeFile(oauthFilePath, JSON.stringify({ tokens: { access_token: "updated-auth", account_id: "account" } })); assert.notEqual(await compatibilityFingerprint({ authMode: "oauth_file", oauthFilePath }), first);
    assert.notEqual(await compatibilityFingerprint({ authMode: "oauth_file", oauthFilePath: "~/auth.json" }), firstTilde);
  } finally {
    if (previousOAuthHome === undefined) delete process.env.LITE_CCSWITCH_OAUTH_FILE_HOME; else process.env.LITE_CCSWITCH_OAUTH_FILE_HOME = previousOAuthHome;
    await rm(data, { recursive: true, force: true });
  }
});
