/**
 * 中文本机交接控制通道：通过权限为 0600 的 Unix 套接字查询、升级或回退。
 * 命令只作用于同一数据目录的监督器；客户端断开不取消已经开始的安全交接。
 */
import net from "node:net";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_MESSAGE_BYTES = 16 * 1024;
export const handoffControlPath = (dataDir) => {
  const directory = `lite-ccswitch-control-${process.getuid?.() ?? "user"}`;
  const name = `${crypto.createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 32)}.sock`;
  const base = Buffer.byteLength(path.join(os.tmpdir(), directory, name)) <= 100 ? os.tmpdir() : "/tmp";
  return path.join(base, directory, name);
};

export async function createHandoffControl({ dataDir, supervisor }) {
  const socketPath = handoffControlPath(await realpath(dataDir)); const clients = new Set();
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const directory = await lstat(path.dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw new Error("交接控制目录必须属于当前用户且权限为 0700");
  const previous = await lstat(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (previous) {
    if (!previous.isSocket()) throw new Error("交接控制路径已存在且不是套接字，保留原文件");
    const active = await new Promise((resolve, reject) => {
      const socket = net.connect(socketPath); socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", (error) => { if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false); else reject(error); });
    });
    if (active) throw new Error("交接控制端口已经由另一个进程使用");
    const current = await lstat(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (current && (current.ino !== previous.ino || current.dev !== previous.dev)) throw new Error("交接控制路径已经改变，停止恢复");
    if (current) await unlink(socketPath);
  }
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    clients.add(socket); socket.once("close", () => clients.delete(socket)); socket.on("error", () => {});
    let bytes = 0; let buffer = ""; let received = false; const decoder = new StringDecoder("utf8");
    socket.setTimeout(10_000, () => { if (!received) socket.destroy(); });
    const reply = (value) => { if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`); };
    socket.on("data", (chunk) => {
      if (received) return;
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES) { received = true; reply({ ok: false, error: "控制命令超过大小限制" }); return; }
      buffer += decoder.write(chunk);
      if (!buffer.includes("\n")) return;
      received = true;
      socket.setTimeout(0);
      void (async () => {
        try {
          const command = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          let worker;
          if (command.action === "upgrade" && typeof command.candidate === "string") worker = await supervisor.upgrade(command.candidate);
          else if (command.action === "upgrade-session" && typeof command.candidate === "string") worker = await supervisor.upgradeSession(command.candidate);
          else if (command.action === "rollback") worker = await supervisor.rollback("本机命令手动回退");
          else if (command.action !== "status") throw new Error("仅支持 status、upgrade-session、upgrade 和 rollback 命令");
          reply({ ok: true, ...(worker ? { worker: worker.id, pid: worker.pid } : {}), state: supervisor.state() });
        } catch (error) { reply({ ok: false, error: error.message, code: error.code, status: error.status }); }
      })();
    });
    socket.once("end", () => { if (!received) socket.end(); });
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolve(); }); });
    await chmod(socketPath, 0o600);
  } catch (error) { server.close(); throw error; }
  let closePromise;
  return { socketPath, close() {
    if (!closePromise) closePromise = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      // 不完整命令无需阻塞退出；已开始的交接由监督器的生命周期收尾。
      for (const socket of clients) socket.destroy();
    });
    return closePromise;
  } };
}

export async function requestHandoffControl(dataDir, command) {
  const dataRoot = await realpath(dataDir);
  return new Promise((resolve, reject) => {
    const socket = net.connect(handoffControlPath(dataRoot)); let chunks = []; let bytes = 0;
    socket.once("error", reject);
    socket.once("connect", () => socket.end(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk) => { bytes += chunk.length; if (bytes > MAX_MESSAGE_BYTES) socket.destroy(new Error("控制响应超过大小限制")); else chunks.push(chunk); });
    socket.once("end", () => {
      try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) throw Object.assign(new Error(value.error), { status: value.status, code: value.code }); resolve(value); }
      catch (error) { reject(error); }
      finally { chunks = []; }
    });
  });
}
