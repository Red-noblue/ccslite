/** 中文发布检查验收：忽略的本机数据不会误报，强制暂存的数据和被工作区掩盖的令牌必须被拒绝。 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ccslite-public-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  await mkdir(path.join(root, "scripts"));
  await copyFile(new URL("../../scripts/check-public-files.mjs", import.meta.url), path.join(root, "scripts/check-public-files.mjs"));
  const git = (...args) => execFileSync("git", args, { cwd: root });
  const check = () => spawnSync(process.execPath, [path.join(root, "scripts/check-public-files.mjs")], { cwd: root, encoding: "utf8" });
  return { root, git, check };
}

test("忽略的运行数据保持本地，强制加入索引时公开检查拒绝", async (t) => {
  const { root, git, check } = await repository(t);
  await writeFile(path.join(root, ".gitignore"), "data/\n");
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data/config.json"), "{}\n");
  assert.equal(check().status, 0);
  git("add", "--force", "data/config.json");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /data\/config\.json/);
});

test("工作区清理不能掩盖索引里待提交的令牌，错误信息不泄露令牌", async (t) => {
  const { root, git, check } = await repository(t);
  const token = "ghp_" + "a".repeat(36);
  const file = path.join(root, "example.js");
  await writeFile(file, `const token = ${JSON.stringify(token)};\n`);
  git("add", "example.js");
  await writeFile(file, "// 已清理工作区，索引仍然保留旧内容。\n");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Git 索引包含疑似GitHub 令牌/);
  assert.ok(!result.stderr.includes(token));
});
