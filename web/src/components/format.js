/**
 * 服务器版管理台格式化工具。
 * 集中处理 Token、金额、时间和熔断状态文案，供迁移后的 React 组件复用。
 */
export function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

export function formatCompactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return formatNumber(number);
}

export function formatMoney(value, digits = 6) {
  return `$${Number(value || 0).toFixed(digits)}`;
}

export function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "";
}

export function stateText(state) {
  if (state === "open") return "已熔断";
  if (state === "half_open") return "半开探测";
  if (state === "closed") return "正常";
  return "未知";
}
