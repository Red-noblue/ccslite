/**
 * 业务请求的交错重试计划。
 * 每个计划项只代表一次向单一供应商发起的请求，不会复制同一个业务请求。
 */

export function buildInterleavedAttemptPlan(providerCount, options = {}) {
  const count = Math.max(0, Math.floor(Number(providerCount) || 0));
  if (count === 0) return [];

  const preferredAttempts = positiveInt(options.preferredAttempts, 6);
  const providerAttempts = positiveInt(options.providerAttempts, 2);
  const maxAttempts = Math.min(30, positiveInt(options.maxAttempts, 30));
  const chunkSize = positiveInt(options.chunkSize, 2);
  const remaining = Array.from({ length: count }, (_, index) =>
    index === 0 ? preferredAttempts : providerAttempts,
  );
  const plan = [];
  const appendChunk = (providerIndex) => {
    if (plan.length >= maxAttempts || remaining[providerIndex] <= 0) return false;
    const size = Math.min(chunkSize, remaining[providerIndex], maxAttempts - plan.length);
    for (let index = 0; index < size; index += 1) plan.push(providerIndex);
    remaining[providerIndex] -= size;
    return size > 0;
  };

  // 首轮先给首选供应商一个小窗口，但为其他供应商至少保留一个槽位。
  // 这样 maxAttempts=2、存在两个供应商时仍然会完成一次故障转移。
  const reservedFallbackSlots = Math.min(count - 1, Math.max(0, maxAttempts - 1));
  const initialSize = Math.min(
    chunkSize,
    remaining[0],
    Math.max(1, maxAttempts - reservedFallbackSlots),
  );
  for (let index = 0; index < initialSize; index += 1) plan.push(0);
  remaining[0] -= initialSize;
  let fallbackCursor = 1;
  while (plan.length < maxAttempts && remaining.some((value) => value > 0)) {
    let fallbackAdded = false;
    if (count > 1) {
      for (let offset = 0; offset < count - 1; offset += 1) {
        const providerIndex = 1 + ((fallbackCursor - 1 + offset) % (count - 1));
        if (!remaining[providerIndex]) continue;
        appendChunk(providerIndex);
        fallbackCursor = providerIndex === count - 1 ? 1 : providerIndex + 1;
        fallbackAdded = true;
        appendChunk(0);
        break;
      }
    }
    if (!fallbackAdded) appendChunk(0);
    if (!plan.length || (remaining.every((value) => value <= 0))) break;
  }
  return plan;
}

export function providerAttemptBudget(providerIndex, options = {}) {
  return Number(providerIndex) === 0
    ? positiveInt(options.preferredAttempts, 6)
    : positiveInt(options.providerAttempts, 2);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
