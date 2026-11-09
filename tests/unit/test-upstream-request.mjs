/**
 * 上游 URL 兼容测试：确保官方 Codex OAuth 不会拼出错误的 /v1 路径。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  isProxyRoute,
  joinUpstreamUrl,
  normalizeProxyPath,
  parseProviderRoute,
} from "../../lib/upstream-request.js";

test("仅保留 Plus 固定路径，普通未知路径不作为固定供应商入口", () => {
  assert.deepEqual(parseProviderRoute("/plus/v1/responses"), {
    routeKey: "plus",
    pathname: "/v1/responses",
  });
  assert.deepEqual(parseProviderRoute("/legacy/v1/models"), {
    routeKey: "cct",
    pathname: "/legacy/v1/models",
  });
  assert.equal(parseProviderRoute("/v1/responses").routeKey, "cct");
  assert.equal(normalizeProxyPath("/legacy/v1/responses"), "/legacy/v1/responses");
  assert.equal(isProxyRoute("/plus/v1/responses"), true);
  assert.equal(isProxyRoute("/legacy/v1/models"), false);
});

test("官方 Codex OAuth 将 Responses 路径映射到 backend-api/codex", () => {
  const provider = {
    upstreamMode: "codex_oauth",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  };
  assert.equal(
    joinUpstreamUrl(provider.baseUrl, "/v1/responses", "", provider),
    "https://chatgpt.com/backend-api/codex/responses",
  );
  assert.equal(
    joinUpstreamUrl(provider.baseUrl, "/v1/models", "?x=1", provider),
    "https://chatgpt.com/backend-api/codex/models?x=1",
  );
});

test("普通 OpenAI 兼容供应商保留 /v1 路径行为", () => {
  assert.equal(
    joinUpstreamUrl("https://example.test/v1", "/v1/responses", ""),
    "https://example.test/v1/responses",
  );
});
