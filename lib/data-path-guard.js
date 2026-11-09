/**
 * 中文运行数据路径保护：拒绝关键数据文件或目录通过软链接写入其他项目。
 */
import { lstat } from "node:fs/promises";
import path from "node:path";

export const PROTECTED_DATA_ENTRIES = [
  "config.json",
  "usage.jsonl",
  "price-lab.json",
  "exchange-rate.json",
  "413-diagnostics.jsonl",
  "group-price-lab",
  "release-recovery",
  "release-process.log",
  "handoff-pending-usage",
  "handoff-write-lease",
  "handoff-active-worker.json",
  "handoff-last-close.json",
  "handoff-events.jsonl",
];

export async function assertNoDataPathSymlinks(dataDir) {
  for (const name of PROTECTED_DATA_ENTRIES) {
    const info = await lstat(path.join(dataDir, name)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) {
      throw new Error(`数据路径不能通过软链接指向其他项目：${name}`);
    }
  }
}
