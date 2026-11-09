/**
 * 供应商统一排序规则：先按分组优先级，再按中文区域名称排序，最后按标识保证顺序稳定。
 */

export function compareProviders(a, b) {
  return (a.sortIndex || 999_999) - (b.sortIndex || 999_999) ||
    String(a.name || "").localeCompare(String(b.name || ""), "zh-CN") ||
    String(a.id || "").localeCompare(String(b.id || ""));
}

export function isHigherPriority(candidate, current) {
  return compareProviders(candidate, current) < 0;
}
