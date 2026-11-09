/**
 * 中文交接事件查询：从当前文件和轮换归档中读取脱敏的交接审计事件。
 */
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";

const CURRENT_NAME = "handoff-events.jsonl";
const ARCHIVE_PREFIX = "handoff-events.";

export async function readHandoffEvents(dataDir, { tail = 50, event = "" } = {}) {
  const root = await realpath(dataDir);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("交接事件查询目录必须是普通目录");
  const names = (await readdir(root)).filter((name) => name === CURRENT_NAME ||
    (name.startsWith(ARCHIVE_PREFIX) && name.endsWith(".jsonl"))).sort();
  const events = [];
  let invalidLines = 0;
  for (const name of names) {
    const file = path.join(root, name);
    const fileInfo = await lstat(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error(`交接事件文件不是普通文件：${name}`);
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (!event || value.event === event) events.push({ ...value, _file: name });
      } catch {
        invalidLines += 1;
      }
    }
  }
  const count = events.length;
  const limit = Math.max(1, Math.min(10_000, Number(tail) || 50));
  return { files: names, count, invalidLines, events: events.slice(-limit) };
}
