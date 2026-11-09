/**
 * 配置持久化验证。
 * 确保坏配置不会被默认值覆盖，并发保存使用独立快照和安全文件权限。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfigStore } from "../../lib/config-store.js";

test("损坏的配置停止加载并原样保留", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-config-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "config.json");
  await writeFile(filePath, '{"providers":');
  await assert.rejects(createConfigStore(filePath).load());
  assert.equal(await readFile(filePath, "utf8"), '{"providers":');
});

test("并发保存固定快照，最终配置完整且权限为 600", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-config-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "config.json");
  const store = createConfigStore(filePath);
  assert.equal(await store.load(), null);
  const config = { version: 1 };
  const first = store.save(config);
  config.version = 2;
  const second = store.save(config);
  config.version = 99;
  await Promise.all([first, second]);
  assert.deepEqual(await store.load(), { version: 2 });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});
