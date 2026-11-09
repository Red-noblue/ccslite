/**
 * 配置文件存储。
 * 损坏或不可读时停止加载；串行写入独立快照，先同步临时文件再原子替换。
 */

import crypto from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export function createConfigStore(filePath) {
  let queue = Promise.resolve();

  async function load() {
    try {
      const data = JSON.parse(await readFile(filePath, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("配置文件必须是 JSON 对象");
      }
      await chmod(filePath, 0o600);
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  function save(config) {
    const snapshot = `${JSON.stringify(config, null, 2)}\n`;
    const task = queue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        const file = await open(tempPath, "wx", 0o600);
        try {
          await file.writeFile(snapshot, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(tempPath, filePath);
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        throw error;
      }
    });
    queue = task;
    return task;
  }

  return { load, save };
}
