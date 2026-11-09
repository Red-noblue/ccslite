/**
 * 美元兑人民币参考汇率：欧洲央行同口径主备渠道、每日缓存及手动系数。
 * 仅由管理操作刷新；原币账单和业务请求均不依赖联网获取汇率。
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { nonRetryableError } from "./proxy-errors.js";

const DAY_MS = 86_400_000;
const RETRY_MS = 3_600_000;
const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/providers/ecb/rates?base=USD&quotes=CNY";
const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

export function createExchangeRateService({ filePath, fetchImpl = fetch, now = Date.now, timeoutMs = 5000 }) {
  let writeQueue = Promise.resolve();

  async function load() {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { mode: "auto", autoRate: null, manualRate: null, lastAttemptAt: null, lastError: null };
    }
  }

  async function save(state) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  function payload(state) {
    const rate = state.mode === "manual" ? state.manualRate : state.autoRate;
    const valid = validRate(rate?.rate) && rate?.base === "USD" && rate?.quote === "CNY";
    return {
      mode: state.mode === "manual" ? "manual" : "auto",
      rate: valid ? rate : null,
      stale: state.mode !== "manual" && (!valid || !Number.isFinite(Date.parse(rate.fetchedAt)) || now() - Date.parse(rate.fetchedAt) >= DAY_MS),
      lastAttemptAt: state.lastAttemptAt || null,
      lastError: state.mode === "manual" ? null : state.lastError || null,
    };
  }

  async function fetchRate(url, parser, source) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parser(await response.text());
      if (!validRate(parsed.rate) || !validDate(parsed.rateDate) || Date.parse(parsed.rateDate) > now() + DAY_MS) {
        throw new Error("汇率或数据日期无效");
      }
      return { base: "USD", quote: "CNY", ...parsed, source, fetchedAt: new Date(now()).toISOString() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function updateState(options) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw nonRetryableError("请提交汇率模式和系数设置。", 400);
    }
    const state = await load();
    if (options.mode !== undefined && !["auto", "manual"].includes(options.mode)) {
      throw nonRetryableError("请选择自动汇率或手动系数。", 400);
    }
    if (options.mode === "manual") {
      const rate = typeof options.rate === "number" || typeof options.rate === "string" ? Number(options.rate) : NaN;
      if (!validRate(rate)) throw nonRetryableError("汇率系数必须是大于 0 的有限数字（1 USD 对应的 CNY）。", 400);
      state.mode = "manual";
      state.manualRate = {
        base: "USD", quote: "CNY", rate,
        rateDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(now())),
        source: "manual", fetchedAt: new Date(now()).toISOString(),
      };
      await save(state);
      return payload(state);
    }
    const changedMode = options.mode === "auto" && state.mode === "manual";
    if (options.mode === "auto") state.mode = "auto";
    if (state.mode === "manual") return payload(state);
    const cached = payload(state);
    const retryDue = !state.lastAttemptAt || now() - Date.parse(state.lastAttemptAt) >= RETRY_MS;
    if (!options.force && (!cached.stale || !retryDue)) {
      if (changedMode) await save(state);
      return cached;
    }
    state.lastAttemptAt = new Date(now()).toISOString();
    const errors = [];
    for (const [url, parser, source] of [
      [FRANKFURTER_URL, parseFrankfurter, "frankfurter_ecb"],
      [ECB_URL, parseEcb, "ecb_xml"],
    ]) {
      try {
        state.autoRate = await fetchRate(url, parser, source);
        state.lastError = null;
        break;
      } catch (error) {
        errors.push(`${source === "ecb_xml" ? "欧洲央行" : "Frankfurter"}：${error.name === "AbortError" ? "获取超时" : error.message}`);
      }
    }
    if (errors.length === 2) state.lastError = errors.join("；");
    await save(state);
    return payload(state);
  }

  return {
    read: async () => payload(await load()),
    update(options = {}) {
      const pending = writeQueue.then(() => updateState(options));
      writeQueue = pending.catch(() => {});
      return pending;
    },
  };
}

function validRate(rate) {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

function validDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || "") && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

function parseFrankfurter(text) {
  const rows = JSON.parse(text);
  const row = Array.isArray(rows) && rows.find((item) => item.base === "USD" && item.quote === "CNY");
  if (!row) throw new Error("响应缺少 USD/CNY 汇率");
  return { rate: row.rate, rateDate: row.date };
}

function parseEcb(text) {
  let rateDate;
  const rates = {};
  for (const tag of text.matchAll(/<Cube\b[^>]*>/g)) {
    const attributes = Object.fromEntries([...tag[0].matchAll(/([\w]+)\s*=\s*["']([^"']*)["']/g)].map((item) => [item[1], item[2]]));
    if (attributes.time) rateDate = attributes.time;
    if (attributes.currency) rates[attributes.currency] = Number(attributes.rate);
  }
  if (!validRate(rates.USD) || !validRate(rates.CNY)) throw new Error("响应缺少 EUR/USD 或 EUR/CNY 汇率");
  return { rate: rates.CNY / rates.USD, rateDate };
}
