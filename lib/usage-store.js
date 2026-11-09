/**
 * Lite CC Switch 用量持久化。
 * 逐行容错读取，追加并同步每条记录；新旧进程排空时不会互相覆盖历史。
 */

import { mkdir, open, readFile, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

function fileIdentity(info) {
  return `${info.dev}:${info.ino}`;
}

function signatureFromInfo(info) {
  return `${info.ino}:${info.size}:${info.mtimeMs}`;
}

function parseRecordLine(line, records, state) {
  if (!line.trim()) return;
  try {
    const record = JSON.parse(line);
    if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    else state.malformedCount += 1;
  } catch {
    state.malformedCount += 1;
  }
}

function reportMalformed(count, warn) {
  if (count > 0) warn(`读取计费日志时跳过 ${count} 条损坏记录，保留其余历史数据`);
}

export async function loadUsageRecords(filePath, warn = console.warn) {
  try {
    const info = await stat(filePath);
    const signature = signatureFromInfo(info);
    const raw = await readFile(filePath, "utf8");
    const records = [];
    const state = { malformedCount: 0 };
    for (const line of raw.split("\n")) {
      parseRecordLine(line, records, state);
    }
    reportMalformed(state.malformedCount, warn);
    return {
      records,
      malformedCount: state.malformedCount,
      signature,
      inode: fileIdentity(info),
      offset: info.size,
      remainder: "",
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { records: [], malformedCount: 0, signature: null, inode: null, offset: 0, remainder: "" };
  }
}

/**
 * 只读取用量文件从指定字节位置开始的新增内容。
 * 文件被截断、轮换或替换时由调用方回退到 loadUsageRecords；末尾不完整行会留到下一次追加继续解析。
 */
export async function loadUsageRecordsFromOffset(filePath, offset = 0, remainder = "", warn = console.warn) {
  const info = await stat(filePath);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.size) {
    return { reset: true, records: [], malformedCount: 0, signature: signatureFromInfo(info), inode: fileIdentity(info), offset: info.size, remainder: "" };
  }

  const records = [];
  const state = { malformedCount: 0 };
  const decoder = new StringDecoder("utf8");
  let carry = String(remainder || "");
  const file = await open(filePath, "r");
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = offset;
    while (position < info.size) {
      const length = Math.min(chunk.length, info.size - position);
      const result = await file.read(chunk, 0, length, position);
      if (!result.bytesRead) break;
      position += result.bytesRead;
      carry += decoder.write(chunk.subarray(0, result.bytesRead));
      const lines = carry.split("\n");
      carry = lines.pop() || "";
      for (const line of lines) parseRecordLine(line, records, state);
    }
    carry += decoder.end();
  } finally {
    await file.close();
  }
  reportMalformed(state.malformedCount, warn);
  return {
    reset: false,
    records,
    malformedCount: state.malformedCount,
    signature: signatureFromInfo(info),
    inode: fileIdentity(info),
    offset: info.size,
    remainder: carry,
  };
}

export async function usageFileSignature(filePath) {
  const info = await stat(filePath);
  return signatureFromInfo(info);
}

export async function usageFileMetadata(filePath) {
  const info = await stat(filePath);
  return { signature: signatureFromInfo(info), inode: fileIdentity(info), size: info.size };
}

export async function appendUsageRecord(filePath, record) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const file = await open(filePath, "a", 0o600);
  try {
    await file.chmod(0o600);
    // 前导换行隔开意外中断留下的半行，同时兼容旧文件末尾没有换行。
    const data = Buffer.from(`\n${JSON.stringify(record)}\n`);
    const result = await file.write(data);
    if (result.bytesWritten !== data.length) throw new Error("用量日志未完整写入");
    await file.sync();
  } finally {
    await file.close();
  }
}
