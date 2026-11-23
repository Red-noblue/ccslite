/** 开发能力检查沙箱：只读写本次合成文件，只运行两条预置 Node 命令，绝不执行模型生成的代码。 */
import crypto from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const FILE_LIMIT = 64 * 1024;
const COMMAND_LIMIT = 16 * 1024;
const schema = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string" };
export const DEVELOPMENT_TOOLS = [
  { name: "read_file", description: "Read input.json, summary.json or result.json.", parameters: schema({ path: string }) },
  { name: "write_file", description: "Create or correct result.json with UTF-8 content.", parameters: schema({ path: string, content: string }) },
  { name: "edit_file", description: "Replace exactly one occurrence in summary.json.", parameters: schema({ path: string, old_text: string, new_text: string }) },
  { name: "run_command", description: "Run only node task-check.mjs inspect or node task-check.mjs verify.", parameters: schema({ command: string }) },
].map((tool) => ({ type: "function", ...tool, strict: true }));

export const DEVELOPMENT_PROMPT = `Complete this small development task using the provided tools. This is an isolated synthetic workspace.
Read input.json to learn nonce, left, right. Compute total = left + right.
Run "node task-check.mjs inspect" to obtain commandCode.
Create result.json containing exactly {"nonce": input nonce, "total": computed total, "commandCode": code from inspect}.
Edit summary.json to set status to "done" and total to the computed total, preserving every other field.
Run "node task-check.mjs verify" and fix any errors. Finally briefly report completion.
Use only the provided tools. You cannot read or modify task-check.mjs. No previous_response_id or external information is needed.`;

export async function createDevelopmentTask({ signal, commandTimeoutMs = 3000 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ccslite-development-"));
  const input = { nonce: crypto.randomBytes(12).toString("hex"), left: crypto.randomInt(10, 1000), right: crypto.randomInt(10, 1000) };
  const preserved = crypto.randomBytes(10).toString("hex");
  const commandCode = crypto.randomBytes(12).toString("hex");
  const evidence = { read: false, create: false, edit: false, command: false, verify: false };
  const expected = { nonce: input.nonce, total: input.left + input.right, commandCode };
  const expectedSummary = { preserved, status: "done", total: expected.total };
  const checkSource = `// 合成任务固定校验程序，模型不可修改。\nimport fs from 'node:fs';\nconst expected = ${JSON.stringify(expected)};\nconst summary = ${JSON.stringify(expectedSummary)};\nconst equal = (a,b) => a && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(k => a[k] === b[k]);\nif (process.argv[2] === 'inspect') console.log(JSON.stringify({commandCode: expected.commandCode}));\nelse { try { if (!equal(JSON.parse(fs.readFileSync('result.json','utf8')),expected) || !equal(JSON.parse(fs.readFileSync('summary.json','utf8')),summary)) throw 0; console.log('VERIFIED'); } catch { console.log('Task verification failed: check result.json and summary.json'); process.exitCode=1; } }\n`;
  let child = null;
  async function read(name) {
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT) throw new Error("文件必须是小于 64 KiB 的普通文件");
    const handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile("utf8"); } finally { await handle.close(); }
  }
  async function verify() {
    try {
      const equal = (a, b) => a && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((key) => a[key] === b[key]);
      return equal(JSON.parse(await read("result.json")), expected) && equal(JSON.parse(await read("summary.json")), expectedSummary)
        && await read("task-check.mjs") === checkSource;
    } catch { return false; }
  }
  async function command(action) {
    signal?.throwIfAborted();
    if (await read("task-check.mjs") !== checkSource) throw new Error("预置程序发生变化，拒绝执行");
    if (action === "verify") {
      for (const name of ["result.json", "summary.json"]) await read(name);
    }
    return new Promise((resolve) => {
      let output = ""; let size = 0; let stopped = false; let settled = false;
      const stop = () => { stopped = true; child?.kill("SIGKILL"); };
      const timer = setTimeout(stop, commandTimeoutMs);
      const finish = (code) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", stop); child = null;
        resolve({ ok: !stopped && code === 0, environmentError: stopped || code === null, exitCode: code, output: stopped ? "命令已取消或超过资源限制" : output.trim() });
      };
      child = spawn(process.execPath, ["task-check.mjs", action], { cwd: directory, shell: false, env: {}, stdio: ["ignore", "pipe", "pipe"] });
      signal?.addEventListener("abort", stop, { once: true });
      const collect = (chunk) => { size += chunk.length; if (size > COMMAND_LIMIT) stop(); else output += chunk.toString(); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      child.once("error", () => finish(null)); child.once("close", finish);
      if (signal?.aborted) stop();
    });
  }
  try {
    await writeFile(path.join(directory, "input.json"), JSON.stringify(input, null, 2), { flag: "wx", mode: 0o600 });
    await writeFile(path.join(directory, "summary.json"), JSON.stringify({ preserved, status: "pending", total: 0 }, null, 2), { flag: "wx", mode: 0o600 });
    await writeFile(path.join(directory, "task-check.mjs"), checkSource, { flag: "wx", mode: 0o600 });
    const canonical = await realpath(directory);
    return {
      directory, evidence, verify,
      async execute(name, args) {
        signal?.throwIfAborted();
        try {
          const tool = DEVELOPMENT_TOOLS.find((item) => item.name === name);
          if (!tool || !args || Array.isArray(args) || typeof args !== "object" ||
              Object.keys(args).length !== tool.parameters.required.length ||
              !tool.parameters.required.every((key) => typeof args[key] === "string")) throw new Error("未知工具或参数不符合定义");
          if (await realpath(directory) !== canonical) throw new Error("任务目录发生变化");
          if (name === "read_file") {
            if (!["input.json", "summary.json", "result.json"].includes(args.path)) throw new Error("只能读取指定任务文件");
            const content = await read(args.path);
            if (args.path === "input.json") evidence.read = true;
            return { ok: true, content };
          }
          if (name === "write_file") {
            if (args.path !== "result.json" || Buffer.byteLength(args.content) > FILE_LIMIT) throw new Error("只能创建小于 64 KiB 的 result.json");
            const handle = await open(path.join(directory, args.path), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
            try {
              const info = await handle.stat();
              if (!info.isFile() || info.nlink !== 1) throw new Error("结果文件必须是独立普通文件");
              await handle.truncate(0); await handle.writeFile(args.content);
            } finally { await handle.close(); }
            evidence.create = true; evidence.verify = false;
            return { ok: true, message: "result.json 已创建" };
          }
          if (name === "edit_file") {
            if (args.path !== "summary.json" || !args.old_text) throw new Error("只能精确修改 summary.json");
            const content = await read(args.path);
            if (content.split(args.old_text).length !== 2) throw new Error("old_text 必须恰好匹配一次");
            const next = content.replace(args.old_text, () => args.new_text);
            if (Buffer.byteLength(next) > FILE_LIMIT) throw new Error("修改后文件超过 64 KiB");
            const handle = await open(path.join(directory, args.path), constants.O_WRONLY | constants.O_NOFOLLOW);
            try { await handle.truncate(0); await handle.writeFile(next); } finally { await handle.close(); }
            evidence.edit = true; evidence.verify = false;
            return { ok: true, message: "summary.json 已修改" };
          }
          const action = args.command === "node task-check.mjs inspect" ? "inspect" : args.command === "node task-check.mjs verify" ? "verify" : null;
          if (!action) throw new Error("只允许两条预置 Node 命令");
          const result = await command(action);
          if (action === "inspect" && result.ok) evidence.command = true;
          if (action === "verify") evidence.verify = result.ok && await verify();
          return result;
        } catch (error) {
          if (signal?.aborted) throw error;
          return { ok: false, error: ["ENOENT", "EEXIST"].includes(error.code) ? (error.code === "ENOENT" ? "文件不存在" : "文件已存在，不能重复创建") : error.code ? "本地文件操作失败" : error.message };
        }
      },
      async cleanup() { child?.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
