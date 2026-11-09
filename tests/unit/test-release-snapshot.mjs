/**
 * 版本快照测试：验证凭据隔离、独立复制、篡改检测，以及进程启动身份的固定性。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createReleaseSnapshot, verifyReleaseSnapshot } from "../../lib/release-snapshot.js";
import { readBuildInfo } from "../../lib/build-info.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "lite-release-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  for (const directory of ["lib", "public", "data", "codex-config", "node_modules/demo"]) await mkdir(path.join(source, directory), { recursive: true });
  for (const [name, value] of Object.entries({
    "server.js": "// 中文测试入口\nconsole.log('test');\n",
    "lib/example.js": "// 中文测试模块\nexport const value=1;\n",
    "package.json": JSON.stringify({ name: "lite-test", version: "0.2.10" }),
    "package-lock.json": "{}", "public/index.html": "<html lang=\"zh-CN\">测试</html>",
    "data/config.json": '{"secret":"production-key"}', "codex-config/auth.json": '{"token":"oauth-secret"}',
    "runtime.env": "SECRET=not-for-release", "node_modules/demo/index.js": "export default 1;",
  })) await writeFile(path.join(source, name), value);
  return { root, source, output: path.join(root, "release") };
}

test("版本包含依赖和前端但排除认证、环境与业务数据，文件独立且不覆盖旧包", async (t) => {
  const f = await fixture(t);
  const manifest = await createReleaseSnapshot(f.source, f.output, "candidate-1");
  assert.ok(manifest.files.some((file) => file.path.startsWith("node_modules/")));
  assert.equal(manifest.files.some((file) => /data|codex-config|runtime.env/.test(file.path)), false);
  assert.equal((await stat(f.output)).mode & 0o777, 0o700);
  assert.notEqual((await stat(path.join(f.source, "server.js"))).ino, (await stat(path.join(f.output, "server.js"))).ino);
  assert.equal((await verifyReleaseSnapshot(f.output)).releaseId, "candidate-1");
  await assert.rejects(createReleaseSnapshot(f.source, f.output, "candidate-2"), { code: "EEXIST" });
  assert.equal((await verifyReleaseSnapshot(f.output)).releaseId, "candidate-1");
});

test("被修改的文件和新增运行数据都阻止启动校验", async (t) => {
  const f = await fixture(t);
  await createReleaseSnapshot(f.source, f.output, "candidate-1");
  const server = path.join(f.output, "server.js");
  const original = await readFile(server);
  await writeFile(server, "// 损坏的入口\n");
  await assert.rejects(verifyReleaseSnapshot(f.output), /校验失败/);
  await writeFile(server, original);
  await mkdir(path.join(f.output, "data"));
  await assert.rejects(verifyReleaseSnapshot(f.output), /未登记内容/);
});

test("缺失静态页面、嵌套输出目录及清单越界路径被拒绝", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createReleaseSnapshot(f.source, path.join(f.source, "release"), "candidate-1"), /源码目录之外/);
  await createReleaseSnapshot(f.source, f.output, "candidate-1");
  const manifestPath = path.join(f.output, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files[0].path = "../secret";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyReleaseSnapshot(f.output), /非法或重复/);
  await rm(path.join(f.source, "public/index.html"));
  await assert.rejects(createReleaseSnapshot(f.source, path.join(f.root, "incomplete"), "candidate-2"), /缺少发布文件/);
});

test("启动身份保持不变，后续磁盘修改仅影响新进程身份", async (t) => {
  const f = await fixture(t);
  const before = readBuildInfo(f.source);
  assert.equal(before.packaged, false);
  assert.ok(Object.isFrozen(before));
  await writeFile(path.join(f.source, "lib/example.js"), "// 中文测试模块\nexport const value=2;\n");
  assert.notEqual(readBuildInfo(f.source).codeHash, before.codeHash);
  await createReleaseSnapshot(f.source, f.output, "candidate-1");
  assert.equal(readBuildInfo(f.output).releaseId, "candidate-1");
});

test("前端入口引用缺失的脚本时禁止打包，避免发布后出现空白页面", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "public/index.html"), '<script src="/assets/missing.js"></script>');
  await assert.rejects(createReleaseSnapshot(f.source, f.output, "broken-ui"), /静态文件缺失/);
});
