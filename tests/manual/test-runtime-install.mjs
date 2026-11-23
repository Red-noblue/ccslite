/** 干净运行安装验收：复制预构建代码，npm ci 仅装运行依赖，再验证自检和本机模拟请求。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(path.join(tmpdir(), "lite-runtime-install-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LITE_CCSWITCH_") && key !== "NODE_PATH"));
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} 退出码 ${code}：${output}`)));
  });
}
async function bytes(directory) {
  let sum = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, item.name);
    sum += item.isDirectory() ? await bytes(name) : (await stat(name)).size;
  }
  return sum;
}
try {
  for (const name of ["server.js", "handoff-runner.mjs", "package.json", "package-lock.json", "VERSION.json", "lib", "public"]) {
    await cp(path.join(source, name), path.join(root, name), { recursive: true });
  }
  // 复用 HTTP 验收场景，安装目录不借用开发副本或正式目录的依赖。
  await mkdir(path.join(root, "tests/integration"), { recursive: true });
  await cp(path.join(source, "tests/integration/test-request-diagnostics.mjs"), path.join(root, "tests/integration/test-request-diagnostics.mjs"));
  const install = await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
  for (const name of ["vite", "react", "react-dom", "typescript", "lucide-react"]) {
    await assert.rejects(access(path.join(root, "node_modules", name)));
  }
  const doctor = JSON.parse(await run(process.execPath, ["lib/install-doctor.js", "--json"]));
  assert.equal(doctor.ok, true);
  await mkdir(path.join(root, "tests/helpers"), { recursive: true });
  await cp(path.join(source, "tests/helpers/development-provider.mjs"), path.join(root, "tests/helpers/development-provider.mjs"));
  await cp(path.join(source, "tests/integration/test-provider-development.mjs"), path.join(root, "tests/integration/test-provider-development.mjs"));
  const http = await run(process.execPath, ["--test", "tests/integration/test-request-diagnostics.mjs", "tests/integration/test-provider-development.mjs"]);
  console.log(JSON.stringify({ node: process.version, install: install.trim(), runtimeDependencyBytes: await bytes(path.join(root, "node_modules")), doctor: doctor.ok, httpTest: http.trim() }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
