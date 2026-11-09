/**
 * 客户端会话上下文缓存。
 *
 * 仅为需要调用方会话鉴权的供应商保存指定请求头，供后续主动连通性测试复用。
 * 上下文只保留在进程内存中，不写入配置、日志或使用记录。
 */

function sessionHeaderNames(provider) {
  if (provider?.authMode !== "client_session") return [];
  return Array.isArray(provider.sessionHeaders) ? provider.sessionHeaders : [];
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return value === undefined ? "" : String(value).trim();
}

export function createClientSessionContextStore({ now = () => Date.now() } = {}) {
  const contexts = new Map();

  function remember(provider, headers) {
    const names = sessionHeaderNames(provider);
    if (names.length === 0) return false;

    const values = {};
    for (const name of names) {
      const value = headerValue(headers, name);
      if (!value) return false;
      values[name] = value;
    }

    contexts.set(provider.id, {
      headers: values,
      expiresAt: now() + provider.sessionTtlMs,
    });
    return true;
  }

  function get(provider) {
    const context = contexts.get(provider?.id);
    if (!context) return null;
    if (context.expiresAt <= now()) {
      contexts.delete(provider.id);
      return null;
    }
    return { ...context.headers };
  }

  function clear(provider) {
    if (provider?.id) contexts.delete(provider.id);
  }

  return { remember, get, clear };
}
