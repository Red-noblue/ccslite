/**
 * Token 用量归一化和供应商有效价格拟合的纯计算模块。
 * 本模块不访问配置或日志文件，便于价格实验和计费逻辑独立验证。
 */

const PRICE_EXPERIMENT_KINDS = [
  "input_short",
  "input_long",
  "output_long",
  "cache_write",
  "cache_read",
];

export function convertCurrencyAmount(amount, currency, exchangeRate) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 ||
      exchangeRate?.base !== "USD" || exchangeRate?.quote !== "CNY" ||
      !Number.isFinite(exchangeRate.rate) || exchangeRate.rate <= 0) return null;
  if (currency === "USD") return { amount: amount * exchangeRate.rate, currency: "CNY" };
  if (currency === "CNY") return { amount: amount / exchangeRate.rate, currency: "USD" };
  return null;
}

export function fitEffectivePrices(equations = []) {
  const names = ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheCreationPerMillion"];
  const matrix = equations.map((row) => row.tokens.map((value) => Number(value || 0) / 1_000_000));
  const costs = equations.map((row) => Number(row.actualCost || 0));
  const observable = names.map((_, column) => matrix.some((row) => row[column] > 0));
  const activeColumns = observable.map((value, index) => value ? index : -1).filter((index) => index >= 0);
  const rank = matrixRank(matrix.map((row) => activeColumns.map((column) => row[column])));
  const solution = solveNonNegativeLeastSquares(matrix, costs, activeColumns);
  const rates = Object.fromEntries(names.map((name, index) => [name, roundPrecise(solution[index] || 0)]));
  const predictions = matrix.map((row) => row.reduce(
    (sum, value, index) => sum + value * Number(solution[index] || 0),
    0,
  ));
  const absoluteError = predictions.reduce(
    (sum, predicted, index) => sum + Math.abs(predicted - costs[index]),
    0,
  );
  const totalCost = costs.reduce((sum, value) => sum + Math.abs(value), 0);
  const relativeError = totalCost > 0 ? absoluteError / totalCost : 0;
  const fullRank = activeColumns.length > 0 && rank === activeColumns.length;
  const status = !fullRank
    ? "insufficient"
    : equations.length >= activeColumns.length + 2 && relativeError <= 0.05
      ? "stable"
      : "provisional";
  const categoryStatus = Object.fromEntries(names.map((name, index) => [
    name,
    !observable[index]
      ? "unobserved"
      : !fullRank
        ? "indistinguishable"
        : rates[name] <= 1e-9
          ? "no_charge_detected"
          : status,
  ]));
  return {
    rates,
    categoryStatus,
    status,
    equationCount: equations.length,
    independentCategoryCount: rank,
    observableCategoryCount: activeColumns.length,
    relativeError: roundPrecise(relativeError),
    nextRecommendedKind: recommendPriceExperiment(equations),
  };
}

export function calculateUsageCost(usage, rates = {}) {
  return roundPrecise(
    Number(usage.ordinaryInputTokens || 0) / 1_000_000 * Number(rates.inputPerMillion || 0) +
      Number(usage.outputTokens || 0) / 1_000_000 * Number(rates.outputPerMillion || 0) +
      Number(usage.cacheReadTokens || 0) / 1_000_000 * Number(rates.cacheReadPerMillion || 0) +
      Number(usage.cacheCreationTokens || 0) / 1_000_000 * Number(rates.cacheCreationPerMillion || 0),
  );
}

export function priceVectorFromUsage(usage = {}) {
  return [
    Number(usage.ordinaryInputTokens || 0),
    Number(usage.outputTokens || 0),
    Number(usage.cacheReadTokens || 0),
    Number(usage.cacheCreationTokens || 0),
  ];
}

export function normalizePriceUsage(usage = {}) {
  return {
    inputTokens: Math.max(0, Number(usage.inputTokens || 0)),
    ordinaryInputTokens: Math.max(0, Number(usage.ordinaryInputTokens || 0)),
    outputTokens: Math.max(0, Number(usage.outputTokens || 0)),
    cacheReadTokens: Math.max(0, Number(usage.cacheReadTokens || 0)),
    cacheCreationTokens: Math.max(0, Number(usage.cacheCreationTokens || 0)),
    totalTokens: Math.max(0, Number(usage.totalTokens || 0)),
    usageFormat: String(usage.usageFormat || "unknown"),
    usageObserved: Boolean(usage.usageObserved),
  };
}

export function calculateActualCost(ledgerCharge, numerator = 1, denominator = 1) {
  const bottom = Number(denominator);
  if (!Number.isFinite(bottom) || bottom <= 0) return 0;
  return roundPrecise(Number(ledgerCharge || 0) * Number(numerator || 0) / bottom);
}

export function roundPrecise(value) {
  return Math.round(Number(value || 0) * 1_000_000_000_000) / 1_000_000_000_000;
}

export function normalizeRawUsage(usage = {}) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return emptyNormalizedUsage();
  }
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const outputTokens = nonNegativeNumber(
    usage.output_tokens ?? usage.completion_tokens,
    0,
  );
  const cacheReadTokens = nonNegativeNumber(
    usage.cache_read_input_tokens ??
      inputDetails.cached_tokens ??
      inputDetails.cache_read_tokens,
    0,
  );
  const cacheCreationTokens = nonNegativeNumber(
    usage.cache_creation_input_tokens ??
      inputDetails.cache_write_tokens ??
      inputDetails.cache_creation_tokens,
    0,
  );
  const reportedInputTokens = nonNegativeNumber(
    usage.input_tokens ?? usage.prompt_tokens,
    0,
  );
  const isAnthropic = Object.prototype.hasOwnProperty.call(usage, "cache_read_input_tokens") ||
    Object.prototype.hasOwnProperty.call(usage, "cache_creation_input_tokens");
  const usageFormat = isAnthropic
    ? "anthropic"
    : usage.input_tokens_details
      ? "openai_responses"
      : usage.prompt_tokens_details
        ? "openai_chat"
        : "generic";
  const ordinaryInputTokens = isAnthropic
    ? reportedInputTokens
    : Math.max(0, reportedInputTokens - cacheReadTokens - cacheCreationTokens);
  const inputTokens = isAnthropic
    ? ordinaryInputTokens + cacheReadTokens + cacheCreationTokens
    : reportedInputTokens;
  const totalTokens = nonNegativeNumber(
    usage.total_tokens,
    inputTokens + outputTokens,
  );
  return {
    inputTokens,
    ordinaryInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
    usageFormat,
    usageObserved: Object.keys(usage).some((key) => /tokens?/i.test(key)),
  };
}

export function emptyNormalizedUsage() {
  return {
    inputTokens: 0,
    ordinaryInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    usageFormat: "unknown",
    usageObserved: false,
  };
}

function solveNonNegativeLeastSquares(matrix, values, activeColumns) {
  const result = [0, 0, 0, 0];
  if (!matrix.length || !activeColumns.length) return result;
  let best = null;
  for (let mask = 1; mask < (1 << activeColumns.length); mask += 1) {
    const columns = activeColumns.filter((_, index) => mask & (1 << index));
    const reduced = matrix.map((row) => columns.map((column) => row[column]));
    const candidate = solveLeastSquares(reduced, values);
    if (!candidate || candidate.some((value) => value < -1e-9)) continue;
    const clipped = candidate.map((value) => Math.max(0, value));
    const squaredError = reduced.reduce((sum, row, rowIndex) => {
      const predicted = row.reduce((total, value, index) => total + value * clipped[index], 0);
      return sum + (predicted - values[rowIndex]) ** 2;
    }, 0);
    if (!best || squaredError < best.squaredError) {
      best = { columns, values: clipped, squaredError };
    }
  }
  if (!best) return result;
  best.columns.forEach((column, index) => { result[column] = best.values[index]; });
  return result;
}

function solveLeastSquares(matrix, values) {
  if (!matrix.length || !matrix[0]?.length) return null;
  const columns = matrix[0].length;
  const normal = Array.from({ length: columns }, () => Array(columns).fill(0));
  const target = Array(columns).fill(0);
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    for (let left = 0; left < columns; left += 1) {
      target[left] += matrix[rowIndex][left] * values[rowIndex];
      for (let right = 0; right < columns; right += 1) {
        normal[left][right] += matrix[rowIndex][left] * matrix[rowIndex][right];
      }
    }
  }
  return solveLinearSystem(normal, target);
}

function solveLinearSystem(matrix, values) {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-14) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function matrixRank(matrix) {
  if (!matrix.length || !matrix[0]?.length) return 0;
  const work = matrix.map((row) => [...row]);
  let rank = 0;
  for (let column = 0; column < work[0].length && rank < work.length; column += 1) {
    let pivot = rank;
    for (let row = rank + 1; row < work.length; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    }
    if (Math.abs(work[pivot][column]) < 1e-12) continue;
    [work[rank], work[pivot]] = [work[pivot], work[rank]];
    const divisor = work[rank][column];
    for (let index = column; index < work[rank].length; index += 1) work[rank][index] /= divisor;
    for (let row = 0; row < work.length; row += 1) {
      if (row === rank) continue;
      const factor = work[row][column];
      for (let index = column; index < work[row].length; index += 1) {
        work[row][index] -= factor * work[rank][index];
      }
    }
    rank += 1;
  }
  return rank;
}

function recommendPriceExperiment(equations) {
  const counts = Object.fromEntries(PRICE_EXPERIMENT_KINDS.map((kind) => [kind, 0]));
  for (const equation of equations) {
    if (counts[equation.kind] !== undefined) counts[equation.kind] += 1;
  }
  return Object.entries(counts).sort((left, right) => left[1] - right[1])[0]?.[0] || "input_short";
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
