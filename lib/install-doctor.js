#!/usr/bin/env node
/** 中文安装自检：只检查本机运行依赖和预构建页面，不联网、不写配置、不启动或重启服务。 */
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [major, minor] = process.versions.node.split(".").map(Number);
const checks = [];
const add = (name, ok, message) => checks.push({ name, ok, message });
add("Node.js", major > 18 || major === 18 && minor >= 17, `${process.versions.node}；最低 18.17，Node 16 不受支持`);
add("平台", ["linux", "darwin"].includes(process.platform), `${process.platform}/${process.arch}；原生 Windows 请使用 WSL`);
add("运行 API", [globalThis.fetch, globalThis.Headers, globalThis.structuredClone, globalThis.AbortSignal?.timeout, os.availableParallelism].every((value) => typeof value === "function"), "需要 fetch、Headers、structuredClone、AbortSignal.timeout 和 availableParallelism");
try {
  await import("undici");
  const require = createRequire(import.meta.url);
  const info = require("undici/package.json");
  add("运行依赖", true, `undici ${info.version} 已可加载；运行服务不需要安装 Vite、React 和 TypeScript`);
} catch {
  add("运行依赖", false, "undici 无法加载；请在此目录执行 npm ci --omit=dev");
}
for (const entry of ["server.js", "handoff-runner.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, entry)], { encoding: "utf8" });
  add(entry, result.status === 0, result.status === 0 ? "入口语法通过" : "入口缺失或当前 Node 无法解析，请核对完整安装包");
}
try {
  const html = await readFile(path.join(root, "public/index.html"), "utf8");
  const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1].split("?")[0]);
  if (!assets.length) throw new Error("未发现预构建资源");
  for (const asset of assets) {
    const resolved = path.resolve(root, `public${asset}`);
    if (!resolved.startsWith(path.join(root, "public") + path.sep)) throw new Error("页面资源路径不合法");
    await access(resolved);
  }
  add("管理页面", true, `${assets.length} 个入口资源存在；无需现场构建前端`);
} catch {
  add("管理页面", false, "预构建页面或引用资源缺失；开发安装请执行 npm ci && npm run web:build");
}
const report = { ok: checks.every((check) => check.ok), node: process.versions.node, platform: process.platform, arch: process.arch, checks };
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  for (const check of checks) console.log(`${check.ok ? "通过" : "未通过"} · ${check.name}：${check.message}`);
  console.log("本检查不验证供应商密钥和网络，也不能解决 Node 二进制本身无法在旧系统启动的问题。");
}
if (!report.ok) process.exitCode = 1;
