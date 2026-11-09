/**
 * 汇率渠道、缓存、手动设置与换算测试，全部使用伪造响应，不访问公网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExchangeRateService } from "../../lib/exchange-rate.js";
import { convertCurrencyAmount } from "../../lib/price-calculation.js";

const DAY_MS = 86_400_000;
const primary = (rate = 6.5) => new Response(JSON.stringify([
  { date: "2026-11-05", base: "USD", quote: "CNY", rate },
]));
const xml = `<gesmes:Envelope><Cube><Cube time="2026-11-05"><Cube currency='USD' rate='1.1'/><Cube rate="7.7" currency="CNY"/></Cube></Cube></gesmes:Envelope>`;

async function fixture(t, fetchImpl, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lite-exchange-rate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = Date.parse("2026-11-06T10:00:00Z");
  const settings = { filePath: path.join(root, "exchange-rate.json"), fetchImpl, now: () => clock, ...options };
  return { service: createExchangeRateService(settings), settings, advance: (ms) => { clock += ms; } };
}

test("自动获取正确系数，并发及重启共享每日缓存，不在读取时联网", async (t) => {
  let calls = 0;
  const { service, settings, advance } = await fixture(t, async () => { calls += 1; return primary(); });
  assert.equal((await service.read()).rate, null);
  assert.equal(calls, 0);
  const responses = await Promise.all([service.update(), service.update(), service.update()]);
  assert.equal(calls, 1);
  assert.equal(responses[0].rate.rate, 6.5);
  assert.equal(responses[0].rate.source, "frankfurter_ecb");
  assert.equal(responses[0].rate.rateDate, "2026-11-05", "保留实际公布日期");
  const restarted = createExchangeRateService(settings);
  assert.equal((await restarted.update()).rate.rate, 6.5);
  assert.equal(calls, 1);
  advance(DAY_MS);
  await restarted.update();
  assert.equal(calls, 2);
  await restarted.update({ force: true });
  assert.equal(calls, 3);
});

test("主源失败或数据不正确时使用欧洲央行 XML 同口径交叉汇率", async (t) => {
  for (const invalid of [new Response("failed", { status: 503 }), primary(-1), new Response('[{"base":"EUR","quote":"CNY","date":"2026-11-05","rate":7}]'), new Response('[{"base":"USD","quote":"CNY","date":"2026-11-31","rate":7}]')]) {
    let calls = 0;
    const { service } = await fixture(t, async () => ++calls === 1 ? invalid : new Response(xml));
    const result = await service.update();
    assert.equal(calls, 2);
    assert.equal(result.rate.source, "ecb_xml");
    assert.ok(Math.abs(result.rate.rate - 7) < 1e-10);
    assert.equal(result.lastError, null);
  }
});

test("双源失败保留上次值、日期及错误，失败冷却避免反复请求", async (t) => {
  let calls = 0;
  let online = true;
  const { service, settings, advance } = await fixture(t, async () => {
    calls += 1;
    if (online) return primary();
    throw new Error("模拟网络断开");
  });
  const previous = (await service.update()).rate;
  online = false;
  advance(DAY_MS);
  const failed = await service.update();
  assert.deepEqual(failed.rate, previous);
  assert.equal(failed.stale, true);
  assert.match(failed.lastError, /Frankfurter.*欧洲央行/);
  const restarted = createExchangeRateService(settings);
  await restarted.update();
  assert.equal(calls, 3, "失败后重启仍遵守冷却时间");
  advance(3_600_000);
  await restarted.update();
  assert.equal(calls, 5);
});

test("首次无网和获取超时不会制造默认汇率或无限等待", async (t) => {
  let calls = 0;
  const { service } = await fixture(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    calls += 1;
    signal.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "AbortError" })), { once: true });
  }), { timeoutMs: 10 });
  const failed = await service.update();
  assert.equal(calls, 2);
  assert.equal(failed.rate, null);
  assert.match(failed.lastError, /获取超时/);
});

test("手动系数持久化、免联网，切回自动恢复之前有效缓存", async (t) => {
  let calls = 0;
  const { service, settings } = await fixture(t, async () => { calls += 1; return primary(); });
  await service.update();
  const manual = await service.update({ mode: "manual", rate: "7.2" });
  assert.equal(manual.rate.rate, 7.2);
  assert.equal(manual.rate.source, "manual");
  const restarted = createExchangeRateService(settings);
  assert.equal((await restarted.update({ force: true })).mode, "manual");
  assert.equal(calls, 1);
  const before = await readFile(settings.filePath, "utf8");
  for (const rate of [0, -1, "", "Infinity", "NaN", null, {}, true]) {
    await assert.rejects(restarted.update({ mode: "manual", rate }), { status: 400 });
    assert.equal(await readFile(settings.filePath, "utf8"), before);
  }
  await assert.rejects(restarted.update({ mode: "invalid" }), { status: 400 });
  for (const invalid of [null, [], 1]) await assert.rejects(restarted.update(invalid), { status: 400 });
  const automatic = await restarted.update({ mode: "auto" });
  assert.equal(automatic.rate.rate, 6.5);
  assert.equal(calls, 1);
  assert.equal((await createExchangeRateService(settings).read()).mode, "auto");
});

test("人民币和美元按相反方向换算，未知币种或无效系数不换算", () => {
  const rate = { base: "USD", quote: "CNY", rate: 7 };
  assert.deepEqual(convertCurrencyAmount(2, "USD", rate), { amount: 14, currency: "CNY" });
  assert.deepEqual(convertCurrencyAmount(14, "CNY", rate), { amount: 2, currency: "USD" });
  assert.deepEqual(convertCurrencyAmount(0, "USD", rate), { amount: 0, currency: "CNY" });
  assert.equal(convertCurrencyAmount(1, "EUR", rate), null);
  assert.equal(convertCurrencyAmount(1, "USD", { ...rate, rate: 0 }), null);
  assert.equal(convertCurrencyAmount(1, "USD", null), null);
  assert.equal(convertCurrencyAmount(null, "USD", rate), null);
});
