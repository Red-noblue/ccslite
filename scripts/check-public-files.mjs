#!/usr/bin/env node
/**
 * 中文公开文件检查：核对 Git 索引和未忽略文件，阻止运行数据、私钥和常见令牌进入公开仓库。
 * 同时检查索引内容与工作区内容；只报告文件位置，不打印疑似密钥。
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root });
const names = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean))];
const indexed = new Set(git("ls-files", "--cached", "-z").toString().split("\0").filter(Boolean));
const forbiddenRoot = new Set(["data", "codex-config", "node_modules", ".venvs", "releases", "fallback-releases", "release-backups"]);
const forbiddenName = /^(?:auth\.json|credentials\.json|tokens?\.json|runtime\.env|\.env(?:\..+)?)$/i;
const signatures = [
  ["私钥", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["GitHub 令牌", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["API 密钥", /\bsk-[A-Za-z0-9_-]{20,}\b/],
];
const failures = new Set();
function inspect(name, content, source) {
  for (const [label, pattern] of signatures) {
    const match = pattern.exec(content);
    if (match) failures.add(`${name}:${content.slice(0, match.index).split("\n").length}：${source}包含疑似${label}`);
  }
}
for (const name of names) {
  const parts = name.split("/");
  if (forbiddenRoot.has(parts[0]) || (forbiddenName.test(parts.at(-1)) && !name.endsWith(".example")) || /\.(?:pem|key|p12|pfx)$/i.test(name)) {
    failures.add(`${name}：本机数据或认证文件不允许发布`);
    continue;
  }
  if (indexed.has(name)) inspect(name, git("show", `:${name}`).toString(), "Git 索引");
  try {
    const file = path.join(root, name);
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) failures.add(`${name}：只允许发布普通文件`);
    else inspect(name, readFileSync(file, "utf8"), "工作区");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
if (failures.size) {
  console.error(`公开文件检查未通过：\n${[...failures].join("\n")}`);
  process.exitCode = 1;
} else console.log(`公开文件检查通过：${names.length} 个文件；未包含禁止路径或命中的常见密钥格式。`);
