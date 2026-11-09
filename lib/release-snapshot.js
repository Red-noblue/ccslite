/**
 * 可独立运行的版本快照：只打包代码、前端和依赖，逐文件校验，排除认证与业务数据。
 * 快照创建后不覆盖已有目录；配置和用量由启动器指向单独的数据目录。
 */
import crypto from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOTS = new Set(["server.js", "handoff-runner.mjs", "lib", "public", "node_modules", "package.json", "package-lock.json",
  "VERSION.json", "restart.sh", "release.mjs", "tests", "web", "scripts", "examples", "README.md", "LICENSE"]);
const REQUIRED = ["server.js", "package.json", "package-lock.json", "public/index.html"];
const MANIFEST = "release-manifest.json";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function inventory(root, relative = "") {
  const files = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!relative && !ROOTS.has(entry.name)) continue;
    if (entry.name === ".bin") continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`版本包不接受软链接：${name}`);
    if (entry.isDirectory()) files.push(...await inventory(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`版本包包含非常规文件：${name}`);
  }
  return files.sort();
}

async function fingerprint(root, files) {
  const result = [];
  for (const name of files) {
    const content = await readFile(path.join(root, name));
    result.push({ path: name, bytes: content.length, sha256: hash(content) });
  }
  return result;
}

async function assertStaticAssets(root, files) {
  const html = await readFile(path.join(root, "public/index.html"), "utf8");
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)) {
    if (/^(?:https?:)?\/\//.test(match[1])) continue;
    const name = `public/${match[1].replace(/^\//, "")}`;
    if (!files.includes(name)) throw new Error(`页面引用的静态文件缺失：${name}`);
  }
}

export async function createReleaseSnapshot(source, destination, releaseId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(releaseId || "")) throw new Error("版本标识只能包含字母、数字、点、横线和下划线");
  const sourceRoot = await realpath(source);
  await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
  const output = path.join(await realpath(path.dirname(path.resolve(destination))), path.basename(path.resolve(destination)));
  if (output === sourceRoot || output.startsWith(`${sourceRoot}${path.sep}`)) throw new Error("版本包必须保存在源码目录之外");
  const files = await inventory(sourceRoot);
  for (const name of REQUIRED) if (!files.includes(name)) throw new Error(`缺少发布文件：${name}`);
  await assertStaticAssets(sourceRoot, files);
  const original = await fingerprint(sourceRoot, files);
  await mkdir(output, { mode: 0o700 });
  for (const name of files) {
    const target = path.join(output, name);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(sourceRoot, name), target);
  }
  const copied = await fingerprint(output, files);
  if (JSON.stringify(original) !== JSON.stringify(copied) ||
      JSON.stringify(files) !== JSON.stringify(await inventory(sourceRoot)) ||
      JSON.stringify(original) !== JSON.stringify(await fingerprint(sourceRoot, files))) {
    throw new Error("打包期间源码发生变化，请使用新的输出目录重试；未生成有效版本清单");
  }
  const packageInfo = JSON.parse(await readFile(path.join(output, "package.json"), "utf8"));
  const manifest = {
    format: 1,
    releaseId,
    version: packageInfo.version,
    createdAt: new Date().toISOString(),
    node: { version: process.version, platform: process.platform, arch: process.arch },
    contentHash: hash(JSON.stringify(copied)),
    files: copied,
  };
  await writeFile(path.join(output, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await verifyReleaseSnapshot(output);
  return manifest;
}

export async function verifyReleaseSnapshot(directory) {
  const root = await realpath(directory);
  const manifestInfo = await lstat(path.join(root, MANIFEST));
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("版本清单必须是普通文件");
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8"));
  if (manifest.format !== 1 || !manifest.node || !Array.isArray(manifest.files) || !manifest.files.length ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(manifest.releaseId || "")) throw new Error("版本清单格式无效");
  const names = manifest.files.map((file) => file.path);
  if (new Set(names).size !== names.length || names.some((name) => typeof name !== "string" ||
      name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..") || !ROOTS.has(name.split("/")[0]))) {
    throw new Error("版本清单包含非法或重复文件路径");
  }
  // 不接受在包内后加的数据、环境文件或认证目录，避免部署包混入运行数据。
  const extras = (await readdir(root)).filter((name) => !ROOTS.has(name) && name !== MANIFEST);
  if (extras.length) throw new Error(`版本包出现未登记内容：${extras.join("、")}`);
  for (const name of REQUIRED) if (!names.includes(name)) throw new Error(`缺少发布文件：${name}`);
  const actualNames = await inventory(root);
  if (JSON.stringify(actualNames) !== JSON.stringify(names)) throw new Error("版本包的文件列表与清单不一致");
  const actual = await fingerprint(root, actualNames);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files) || hash(JSON.stringify(actual)) !== manifest.contentHash) {
    throw new Error("版本包校验失败，文件已损坏或被修改");
  }
  await assertStaticAssets(root, actualNames);
  const packageInfo = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (packageInfo.version !== manifest.version) throw new Error("版本清单与 package.json 版本不一致");
  if (manifest.node.platform !== process.platform || manifest.node.arch !== process.arch) throw new Error("版本包与本机平台或架构不一致");
  return manifest;
}
