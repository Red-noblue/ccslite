/**
 * 流式等待策略的默认值与边界：回退窗口按首包计时，无进展治理默认关闭。
 * 配置加载、管理接口与转发模块共用规则，避免界面值与实际等待行为不一致。
 */
export const DEFAULT_STREAM_POLICY = Object.freeze({
  streamingDeferredOutputGraceMs: 1500,
  streamingDeferredBufferBytes: 256 * 1024,
  streamingProgressTimeoutMs: 0,
});

function integer(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.floor(Math.min(max, Math.max(min, number))) : fallback;
}

export function normalizeStreamPolicy(input = {}, fallback = DEFAULT_STREAM_POLICY) {
  return {
    streamingDeferredOutputGraceMs: integer(input.streamingDeferredOutputGraceMs, fallback.streamingDeferredOutputGraceMs, 0, 300_000),
    streamingDeferredBufferBytes: integer(input.streamingDeferredBufferBytes, fallback.streamingDeferredBufferBytes, 1024, 4 * 1024 * 1024),
    streamingProgressTimeoutMs: integer(input.streamingProgressTimeoutMs, fallback.streamingProgressTimeoutMs, 0, 86_400_000),
  };
}
