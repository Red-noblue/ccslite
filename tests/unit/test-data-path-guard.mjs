/**
 * 中文运行数据路径保护测试：覆盖汇率文件和普通数据文件的软链接拦截。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoDataPathSymlinks, PROTECTED_DATA_ENTRIES } from "../../lib/data-path-guard.js";

test("汇率文件属于受保护的数据路径，软链接会被拒绝", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-data-path-guard-"));
  try {
    const outside = path.join(root, "outside.json");
    await writeFile(outside, "{}\n");
    await symlink(outside, path.join(root, "exchange-rate.json"));
    assert.ok(PROTECTED_DATA_ENTRIES.includes("exchange-rate.json"));
    await assert.rejects(assertNoDataPathSymlinks(root), /exchange-rate\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
