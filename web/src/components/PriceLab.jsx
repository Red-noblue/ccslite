/**
 * 供应商真实价格实验与长期校准界面。
 * 每次实验只发送一个直连请求，并在录入对应账面扣费后计算实际现金成本。
 */
import { Calculator, FlaskConical, Loader2, RefreshCw, Save, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatNumber, formatTime } from "./format.js";
import { InfoHint } from "./InfoHint.jsx";
import { ExchangeRatePanel } from "./ExchangeRatePanel.jsx";
import { convertCurrencyAmount } from "../../../lib/price-calculation.js";

const TEST_KINDS = [
  { value: "input_short", label: "短输入 / 短输出" },
  { value: "input_long", label: "较长普通输入" },
  { value: "output_long", label: "较长输出" },
  { value: "cache_write", label: "缓存首次写入" },
  { value: "cache_read", label: "缓存重复读取" },
];

const RATE_FIELDS = [
  ["inputPerMillion", "普通输入"],
  ["outputPerMillion", "输出"],
  ["cacheReadPerMillion", "缓存读取"],
  ["cacheCreationPerMillion", "缓存写入"],
];

const CURRENCIES = [
  { value: "CNY", label: "人民币（CNY）" },
  { value: "USD", label: "美元（USD）" },
];

const REASONING_EFFORTS = [
  ["", "上游默认"], ["none", "none"], ["minimal", "minimal"], ["low", "low"],
  ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"],
];

export function PriceLab({ providers = [], apiClient, providerFilter, mode = "experiment" }) {
  const [data, setData] = useState({ samples: [], checkpoints: [], profiles: [], pendingSample: null });
  const [providerId, setProviderId] = useState(providerFilter?.id || providers[0]?.id || "");
  const [model, setModel] = useState("gpt-6.1-sol");
  const [reasoningEffort, setReasoningEffort] = useState("xhigh");
  const [currency, setCurrency] = useState("CNY");
  const [exchangeRate, setExchangeRate] = useState(null);
  const [kind, setKind] = useState("input_short");
  const [ledgerCharge, setLedgerCharge] = useState("");
  const [numerator, setNumerator] = useState("1");
  const [denominator, setDenominator] = useState("1");
  const [cumulativeCharge, setCumulativeCharge] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (providerFilter?.id) setProviderId(providerFilter.id);
  }, [providerFilter?.id]);

  const groupKey = `${providerId}::${model}::${currency}`;
  const profile = data.profiles.find((item) => item.groupKey === groupKey) || null;
  const groupSamples = data.samples.filter((sample) =>
    sample.providerId === providerId && sample.requestModel === model && sample.currency === currency,
  );
  const cacheSamples = groupSamples.filter((sample) =>
    sample.kind === "cache_write" && sample.valid !== false && sample.cacheKey,
  );
  const latestCacheSample = cacheSamples[0] || null;
  const checkpoints = data.checkpoints.filter((item) => item.groupKey === groupKey);
  const pending = data.pendingSample;
  const actualPreview = useMemo(() => {
    const charge = Number(ledgerCharge);
    const top = Number(numerator);
    const bottom = Number(denominator);
    return Number.isFinite(charge) && Number.isFinite(top) && Number.isFinite(bottom) && bottom > 0
      ? charge * top / bottom
      : null;
  }, [ledgerCharge, numerator, denominator]);

  async function load() {
    try {
      const next = await apiClient("/api/price-lab");
      setData(next);
      setMessage("");
      if (next.pendingSample) {
        setProviderId(next.pendingSample.providerId);
        setModel(next.pendingSample.requestModel);
        setReasoningEffort(next.pendingSample.reasoningEffort || "");
        setCurrency(next.pendingSample.currency);
      }
    } catch (error) {
      setMessage(`读取失败：${error.message}`);
    }
  }

  async function runExperiment() {
    setBusy(true);
    setMessage("正在发送一次直连实验请求...");
    try {
      const result = await apiClient("/api/price-lab/requests", {
        method: "POST",
        body: JSON.stringify({ providerId, model, reasoningEffort, currency, kind, cacheKey: latestCacheSample?.cacheKey || "" }),
      });
      setData(result.priceLab);
      setLedgerCharge("");
      setMessage("请求已完成，请从供应商后台复制这一条请求的账面扣费");
    } catch (error) {
      setMessage(`实验请求失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveBilling() {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await apiClient(`/api/price-lab/samples/${encodeURIComponent(pending.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          billing: { ledgerCharge, numerator, denominator, currency: pending.currency },
        }),
      });
      setData(result.priceLab);
      setLedgerCharge("");
      const nextProfile = result.priceLab.profiles.find((item) => item.groupKey === groupKey);
      if (nextProfile?.nextRecommendedKind) setKind(nextProfile.nextRecommendedKind);
      setMessage("");
    } catch (error) {
      setMessage(`保存扣费失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function invalidatePending() {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await apiClient(`/api/price-lab/samples/${encodeURIComponent(pending.id)}`, {
        method: "PUT",
        body: JSON.stringify({ valid: false, invalidReason: "用户在价格实验界面标记为无效" }),
      });
      setData(result.priceLab);
      setMessage("样本已标记为无效，可以继续实验");
    } catch (error) {
      setMessage(`标记失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSample(sample) {
    if (!window.confirm(`确认删除 ${formatTime(sample.timestamp)} 的${testKindLabel(sample.kind)}实验记录？删除后会重新拟合价格参数。`)) return;
    setBusy(true);
    try {
      const result = await apiClient(`/api/price-lab/samples/${encodeURIComponent(sample.id)}`, { method: "DELETE" });
      setData(result.priceLab);
      setMessage("");
    } catch (error) {
      setMessage(`删除实验记录失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveCheckpoint(checkpointMode) {
    setBusy(true);
    try {
      const result = await apiClient("/api/price-lab/checkpoints", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          model,
          currency,
          cumulativeLedgerCharge: cumulativeCharge,
          numerator,
          denominator,
          mode: checkpointMode,
        }),
      });
      setData(result.priceLab);
      setCumulativeCharge("");
      setMessage(checkpointMode === "baseline" ? "长期校准基线已建立" : "长期校准点已保存并参与价格拟合");
    } catch (error) {
      setMessage(`保存校准点失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCheckpoint(checkpoint) {
    if (!window.confirm(`确认删除 ${formatTime(checkpoint.timestamp)} 的${checkpoint.type === "baseline" ? "基线" : "校准"}记录？删除后会重新拟合价格参数。`)) return;
    setBusy(true);
    try {
      const result = await apiClient(`/api/price-lab/checkpoints/${encodeURIComponent(checkpoint.id)}`, { method: "DELETE" });
      setData(result.priceLab);
      setMessage("");
    } catch (error) {
      setMessage(`删除校准记录失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="price-lab">
      <div className="price-lab-toolbar">
        <div className="price-lab-selector-grid">
          <label><span>供应商</span><select value={providerId} onChange={(event) => setProviderId(event.target.value)} disabled={Boolean(pending)}>
            {providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
          </select></label>
          <label><span>模型</span><input value={model} onChange={(event) => setModel(event.target.value)} disabled={Boolean(pending)} /></label>
          <label><span>思考强度</span><select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)} disabled={Boolean(pending)}>
            {REASONING_EFFORTS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          <label><span>计价币种 <InfoHint>实际花费与价格参数的币种；人民币和美元分别记录。充值折算比例仍由分子、分母设置。</InfoHint></span><select value={currency} onChange={(event) => setCurrency(event.target.value)} disabled={Boolean(pending)}>
            {CURRENCIES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
            {!CURRENCIES.some((item) => item.value === currency) && <option value={currency}>{currency}（历史币种）</option>}
          </select></label>
        </div>
        <button className="cc-button cc-button-secondary" type="button" onClick={load} disabled={busy} title="刷新价格实验数据">
          <RefreshCw size={15} />刷新
        </button>
      </div>

      {message && <div className="price-lab-message" aria-live="polite">{busy && <Loader2 className="spin" size={15} />}{message}</div>}

      <ExchangeRatePanel apiClient={apiClient} value={exchangeRate} onChange={setExchangeRate} />

      {mode === "experiment" ? (
        <>
          <PriceProfile profile={profile} currency={currency} exchangeRate={exchangeRate?.rate} />
          {pending ? (
            <PendingBilling
              sample={pending}
              ledgerCharge={ledgerCharge}
              setLedgerCharge={setLedgerCharge}
              numerator={numerator}
              setNumerator={setNumerator}
              denominator={denominator}
              setDenominator={setDenominator}
              actualPreview={actualPreview}
              exchangeRate={exchangeRate?.rate}
              onSave={saveBilling}
              onInvalidate={invalidatePending}
              busy={busy}
            />
          ) : (
            <article className="usage-card price-request-panel">
              <div className="usage-card-head">
                <div><h3>增加单次价格样本 <InfoHint>请求只发送到当前供应商，不进入故障转移。</InfoHint></h3></div>
                <span className="state-pill neutral">已完成 {formatNumber(groupSamples.filter((item) => item.billing && item.valid !== false).length)} 条</span>
              </div>
              <div className="price-request-controls">
                <label><span>测试类型</span><select value={kind} onChange={(event) => setKind(event.target.value)}>
                  {TEST_KINDS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
                </select></label>
                {kind === "cache_read" && <div className="latest-cache-sample"><span>缓存写入样本</span><strong>{latestCacheSample ? `${formatTime(latestCacheSample.timestamp)} · 自动使用最近样本` : "暂无可用样本"}</strong></div>}
                <button className="cc-button cc-button-primary" type="button" onClick={runExperiment} disabled={busy || !providerId || !model || (kind === "cache_read" && !latestCacheSample)}>
                  <FlaskConical size={15} />发送一次请求
                </button>
              </div>
            </article>
          )}
          <PriceSampleTable samples={groupSamples} onDelete={deleteSample} busy={busy} />
        </>
      ) : (
        <>
          <PriceProfile profile={profile} currency={currency} exchangeRate={exchangeRate?.rate} />
          <article className="usage-card checkpoint-form">
            <div className="usage-card-head">
              <div><h3>记录 Key 累计花费 <InfoHint>先建立基线；之后按两个校准点之间的累计花费差额计算。</InfoHint></h3></div>
            </div>
            <div className="checkpoint-inputs">
              <label><span>累计账面花费</span><input type="number" min="0" step="any" value={cumulativeCharge} onChange={(event) => setCumulativeCharge(event.target.value)} /></label>
              <RatioFields numerator={numerator} setNumerator={setNumerator} denominator={denominator} setDenominator={setDenominator} />
            </div>
            <div className="checkpoint-actions">
              <button className="cc-button cc-button-secondary" type="button" onClick={() => saveCheckpoint("baseline")} disabled={busy || cumulativeCharge === ""}>建立新基线</button>
              <button className="cc-button cc-button-primary" type="button" onClick={() => saveCheckpoint("checkpoint")} disabled={busy || cumulativeCharge === "" || !checkpoints.length}>
                <Calculator size={15} />计算并校准
              </button>
            </div>
          </article>
          <CheckpointTable checkpoints={checkpoints} currency={currency} onDelete={deleteCheckpoint} busy={busy} />
        </>
      )}
    </div>
  );
}

function PendingBilling({ sample, ledgerCharge, setLedgerCharge, numerator, setNumerator, denominator, setDenominator, actualPreview, exchangeRate, onSave, onInvalidate, busy }) {
  return (
    <article className="usage-card pending-billing">
      <div className="usage-card-head">
        <div><h3>等待录入本次扣费</h3><p>{sample.providerName} · {sample.requestModel}{sample.reasoningEffort ? ` · ${sample.reasoningEffort}` : ""} · {testKindLabel(sample.kind)} · {formatTime(sample.timestamp)}</p></div>
        <span className={`state-pill ${sample.statusCode >= 200 && sample.statusCode < 300 ? "ok" : "warn"}`}>上游 {sample.statusCode || "无响应"}</span>
      </div>
      <UsageNumbers usage={sample.usage} />
      {sample.error && <div className="price-lab-error">{sample.error}</div>}
      <div className="billing-inputs">
        <label><span>本次账面扣费</span><input type="number" min="0" step="any" value={ledgerCharge} onChange={(event) => setLedgerCharge(event.target.value)} autoFocus /></label>
        <RatioFields numerator={numerator} setNumerator={setNumerator} denominator={denominator} setDenominator={setDenominator} />
        <div className="actual-cost-preview"><span>折算实际花费</span><strong>{actualPreview === null ? "-" : `${sample.currency} ${formatCost(actualPreview)}`}</strong><ConvertedCost amount={actualPreview} currency={sample.currency} exchangeRate={exchangeRate} /></div>
      </div>
      <div className="pending-actions">
        <button className="cc-button cc-button-primary" type="button" onClick={onSave} disabled={busy || ledgerCharge === ""}><Save size={15} />确认并保存</button>
        <button className="cc-button cc-button-secondary" type="button" onClick={onInvalidate} disabled={busy}><X size={15} />标记无效</button>
      </div>
      <details><summary>查看供应商返回的原始 usage</summary><pre>{JSON.stringify(sample.rawUsage, null, 2)}</pre></details>
    </article>
  );
}

function RatioFields({ numerator, setNumerator, denominator, setDenominator }) {
  return (
    <div className="ratio-fields">
      <label><span>折算分子</span><input type="number" min="0" step="any" value={numerator} onChange={(event) => setNumerator(event.target.value)} /></label>
      <span className="ratio-divider">÷</span>
      <label><span>折算分母</span><input type="number" min="0.000000000001" step="any" value={denominator} onChange={(event) => setDenominator(event.target.value)} /></label>
    </div>
  );
}

function PriceProfile({ profile, currency, exchangeRate }) {
  return (
    <article className="usage-card price-profile">
      <div className="usage-card-head">
        <div><h3>当前有效价格参数 <InfoHint>单位为 {currency} / 百万 Token，新增样本或校准点后会重新拟合。</InfoHint></h3></div>
        <span className={`state-pill ${profile?.status === "stable" ? "ok" : profile ? "warn" : "neutral"}`}>{profileStatus(profile?.status)}</span>
      </div>
      <div className="price-rate-grid">
        {RATE_FIELDS.map(([key, label]) => <div key={key}><span>{label}</span><strong>{profile ? formatCost(profile.rates?.[key]) : "-"}</strong><ConvertedCost amount={profile?.rates?.[key]} currency={currency} exchangeRate={exchangeRate} /><small>{categoryStatus(profile?.categoryStatus?.[key])}</small></div>)}
      </div>
      {profile && <div className="profile-meta"><span>计费数据 {profile.equationCount} 条 <InfoHint>参与本次价格拟合的单请求样本和长期校准区间总数。</InfoHint></span><span>可单独估价 {profile.independentCategoryCount}/{profile.observableCategoryCount} 类 <InfoHint>分母是样本中实际出现的 Token 类别；分子是其中价格可以彼此区分的类别。</InfoHint></span><span>拟合偏差 {(Number(profile.relativeError || 0) * 100).toFixed(2)}%</span><span>建议下一项：{testKindLabel(profile.nextRecommendedKind)}</span></div>}
    </article>
  );
}

function UsageNumbers({ usage = {} }) {
  return <div className="price-usage-grid">
    <div><span>普通输入</span><strong>{formatNumber(usage.ordinaryInputTokens)}</strong></div>
    <div><span>输出</span><strong>{formatNumber(usage.outputTokens)}</strong></div>
    <div><span>缓存读取</span><strong>{formatNumber(usage.cacheReadTokens)}</strong></div>
    <div><span>缓存写入</span><strong>{formatNumber(usage.cacheCreationTokens)}</strong></div>
  </div>;
}

function PriceSampleTable({ samples, onDelete, busy }) {
  return <article className="usage-card"><div className="usage-card-head"><div><h3>单请求实验记录 <InfoHint>每行对应供应商后台的一条计费记录。</InfoHint></h3></div><span className="state-pill neutral">{formatNumber(samples.length)} 条</span></div>
    <div className="cc-table"><table><thead><tr><th>时间</th><th>类型</th><th className="right">普通输入</th><th className="right">输出</th><th className="right">缓存读</th><th className="right">缓存写</th><th className="right">实际花费</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>{samples.length ? samples.slice(0, 50).map((sample) => <tr key={sample.id}><td>{formatTime(sample.timestamp)}</td><td>{testKindLabel(sample.kind)}</td><td className="right">{formatNumber(sample.usage?.ordinaryInputTokens)}</td><td className="right">{formatNumber(sample.usage?.outputTokens)}</td><td className="right">{formatNumber(sample.usage?.cacheReadTokens)}</td><td className="right">{formatNumber(sample.usage?.cacheCreationTokens)}</td><td className="right">{sample.billing ? <>{sample.currency} {formatCost(sample.billing.actualCost)}<ConvertedCost amount={sample.billing.actualCost} currency={sample.currency} exchangeRate={sample.billing.exchangeRate} /></> : "待录入"}</td><td><span className={`state-pill ${sample.valid === false ? "bad" : sample.billing ? "ok" : "warn"}`}>{sample.valid === false ? "无效" : sample.billing ? "已计费" : "待录入"}</span></td><td><button className="cc-button cc-button-secondary cc-button-sm" type="button" onClick={() => onDelete(sample)} disabled={busy}>删除</button></td></tr>) : <tr><td colSpan="9" className="empty-cell">暂无价格实验样本</td></tr>}</tbody>
    </table></div></article>;
}

function CheckpointTable({ checkpoints, currency, onDelete, busy }) {
  return <article className="usage-card"><div className="usage-card-head"><div><h3>长期校准记录 <InfoHint>缓存读取率按两个校准点之间的实际上游 Token 计算。</InfoHint></h3></div><span className="state-pill neutral">{formatNumber(checkpoints.length)} 个点</span></div>
    <div className="cc-table"><table><thead><tr><th>时间</th><th>类型</th><th className="right">累计账面</th><th className="right">区间实际</th><th className="right">本地预测</th><th className="right">偏差</th><th className="right">缓存读取率</th><th>操作</th></tr></thead>
      <tbody>{checkpoints.length ? checkpoints.map((item) => <tr key={item.id}><td>{formatTime(item.timestamp)}</td><td>{item.type === "baseline" ? "基线" : "校准"}</td><td className="right">{formatCost(item.cumulativeLedgerCharge)}</td><td className="right">{item.actualCost === undefined ? "-" : <>{currency} {formatCost(item.actualCost)}<ConvertedCost amount={item.actualCost} currency={currency} exchangeRate={item.exchangeRate} /></>}</td><td className="right">{item.predictedCost === null || item.predictedCost === undefined ? "-" : `${currency} ${formatCost(item.predictedCost)}`}</td><td className="right">{item.deviationRate === null || item.deviationRate === undefined ? "-" : `${(item.deviationRate * 100).toFixed(2)}%`}</td><td className="right">{item.usage?.cacheReadRate === null || item.usage?.cacheReadRate === undefined ? "-" : `${(item.usage.cacheReadRate * 100).toFixed(2)}%`}</td><td><button className="cc-button cc-button-secondary cc-button-sm" type="button" onClick={() => onDelete(item)} disabled={busy}>删除</button></td></tr>) : <tr><td colSpan="8" className="empty-cell">尚未建立长期校准基线</td></tr>}</tbody>
    </table></div></article>;
}

function testKindLabel(value) {
  return TEST_KINDS.find((item) => item.value === value)?.label || value || "未知";
}

function profileStatus(value) {
  return value === "stable" ? "参数稳定" : value === "provisional" ? "暂定参数" : value === "insufficient" ? "样本不足" : "尚未计算";
}

function categoryStatus(value) {
  return value === "stable" ? "已稳定" : value === "provisional" ? "暂定" : value === "unobserved" ? "供应商未返回" : value === "indistinguishable" ? "暂时无法区分" : value === "no_charge_detected" ? "未检测到计费" : "等待样本";
}

function formatCost(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 12 });
}

function ConvertedCost({ amount, currency, exchangeRate }) {
  const converted = convertCurrencyAmount(amount, currency, exchangeRate);
  if (!converted) return null;
  return <small className="converted-cost" title={`1 USD = ${exchangeRate.rate} CNY；数据日期 ${exchangeRate.rateDate}${exchangeRate.stale ? "（沿用缓存）" : ""}`}>约 {converted.currency} {formatCost(converted.amount)}</small>;
}
