/**
 * 供应商级代理配置测试。
 * 验证本机端口快捷写法和 HTTP/HTTPS 代理地址的归一化行为。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createProvider,
  sanitizeProvider,
  updateProvider,
} from "../../lib/provider-config.js";

test("供应商代理端口会归一化为本机 HTTP 代理 URL", () => {
  const provider = createProvider({
    name: "代理供应商",
    baseUrl: "https://example.com/v1",
    proxyUrl: "7890",
  });
  assert.equal(provider.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(sanitizeProvider(provider).proxyUrl, "http://127.0.0.1:7890");
});

test("供应商代理支持完整 HTTP URL，非法协议按直连处理", () => {
  const provider = createProvider({ proxyUrl: "https://127.0.0.1:8443/" });
  assert.equal(provider.proxyUrl, "https://127.0.0.1:8443");
  updateProvider(provider, { proxyUrl: "socks5://127.0.0.1:7890" });
  assert.equal(provider.proxyUrl, "");
});

