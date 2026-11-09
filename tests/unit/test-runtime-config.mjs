/**
 * 运行时配置测试。
 * 验证默认只监听本机，以及自定义数据路径和公网认证配置能够被统一解析。
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRuntimeConfig, loadRuntimeEnvironment } from "../../lib/runtime-config.js";

test("独立数据目录覆盖全部默认写入路径，显式文件路径仍优先", () => {
  const runtime = createRuntimeConfig({ dirname: "/tmp/production", env: {
    LITE_CCSWITCH_DATA_DIR: "/tmp/isolated/data",
    LITE_CCSWITCH_USAGE: "/tmp/isolated/other-usage.jsonl",
  } });
  for (const field of ["dataDir", "configPath", "usagePath", "priceLabPath", "payloadDiagnosticsPath"]) {
    assert.ok(runtime[field].startsWith("/tmp/isolated/"), field);
  }
  assert.equal(runtime.usagePath, "/tmp/isolated/other-usage.jsonl");
});

test("默认监听回环地址并使用项目 data 目录", () => {
  const runtime = createRuntimeConfig({ dirname: "/tmp/lite-ccswitch" , env: {} });
  assert.equal(runtime.listenHost, "127.0.0.1");
  assert.equal(runtime.isLoopback, true);
  assert.equal(runtime.usagePath, path.join("/tmp/lite-ccswitch", "data", "usage.jsonl"));
});

test("启动环境文件只解析赋值，显式环境变量优先", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lite-runtime-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "runtime.env");
  await writeFile(filePath, 'LITE_CCSWITCH_USAGE="/tmp/usage with spaces.jsonl"\nLITE_CCSWITCH_HOST=0.0.0.0\nLITE_CCSWITCH_PROXY_TOKEN=literal$(no-shell)\n');
  const env = loadRuntimeEnvironment(root, {
    LITE_CCSWITCH_ENV_FILE: filePath,
    LITE_CCSWITCH_HOST: "127.0.0.1",
  });
  assert.equal(env.LITE_CCSWITCH_USAGE, "/tmp/usage with spaces.jsonl");
  assert.equal(env.LITE_CCSWITCH_HOST, "127.0.0.1");
  assert.equal(env.LITE_CCSWITCH_PROXY_TOKEN, "literal$(no-shell)");
});

test("公网监听复用代理令牌保护管理接口并保留自定义路径", () => {
  const runtime = createRuntimeConfig({
    dirname: "/tmp/lite-ccswitch",
    env: {
      LITE_CCSWITCH_HOST: "0.0.0.0",
      LITE_CCSWITCH_PORT: "18080",
      LITE_CCSWITCH_USAGE: "/var/lib/lite/usage.jsonl",
      LITE_CCSWITCH_PROXY_TOKEN: "proxy-token",
    },
  });
  assert.equal(runtime.isLoopback, false);
  assert.equal(runtime.listenPort, 18080);
  assert.equal(runtime.adminToken, "proxy-token");
  assert.equal(runtime.usagePath, "/var/lib/lite/usage.jsonl");
});
