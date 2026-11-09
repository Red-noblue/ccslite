/**
 * 供应商级上游代理连接器。
 * 每个供应商可独立使用 HTTP/HTTPS 代理，未配置时保持直连。
 */

import { ProxyAgent } from "undici";

const agents = new Map();

export function getProviderDispatcher(provider) {
  const proxyUrl = String(provider?.proxyUrl || "").trim();
  if (!proxyUrl) return undefined;
  if (!agents.has(proxyUrl)) {
    agents.set(proxyUrl, new ProxyAgent(proxyUrl));
  }
  return agents.get(proxyUrl);
}

