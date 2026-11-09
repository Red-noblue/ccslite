/**
 * 价格实验的人民币/美元参考汇率面板，展示系数、日期、来源并支持手动设置。
 * 自动模式按缓存周期刷新；网络失败时保留最近成功系数。
 */
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatTime } from "./format.js";

export function ExchangeRatePanel({ apiClient, value, onChange }) {
  const [mode, setMode] = useState("auto");
  const [manualRate, setManualRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    async function refresh() {
      try {
        const cached = await apiClient("/api/price-lab/exchange-rate");
        if (mounted) onChange(cached);
        const updated = await apiClient("/api/price-lab/exchange-rate", { method: "POST", body: "{}" });
        if (mounted) { onChange(updated); setError(""); }
      } catch (failure) {
        if (mounted) setError(`读取汇率失败：${failure.message}`);
      }
    }
    refresh();
    const timer = setInterval(refresh, 3_600_000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (value) {
      setMode(value.mode);
      setManualRate(value.rate ? String(value.rate.rate) : "");
    }
  }, [value]);

  async function update(options) {
    setBusy(true);
    setError("");
    try {
      onChange(await apiClient("/api/price-lab/exchange-rate", { method: "POST", body: JSON.stringify(options) }));
    } catch (failure) {
      setError(`更新汇率失败：${failure.message}`);
    } finally {
      setBusy(false);
    }
  }

  const rate = value?.rate;
  const source = rate?.source === "manual" ? "手动系数" : rate?.source === "ecb_xml" ? "欧洲央行 XML" : "Frankfurter · 欧洲央行";
  return <article className="usage-card exchange-rate-panel">
    <div className="usage-card-head"><div><h3>人民币 / 美元参考汇率</h3><p>用于金额参考换算；保存扣费时记录当时的系数。</p></div></div>
    <div className="exchange-rate-controls">
      <label><span>汇率模式</span><select value={mode} disabled={busy} onChange={(event) => {
        const selected = event.target.value;
        setMode(selected);
        if (selected === "auto") update({ mode: "auto" });
      }}><option value="auto">自动获取（欧洲央行）</option><option value="manual">手动系数</option></select></label>
      {mode === "manual" ? <>
        <label><span>1 USD 对应的 CNY</span><input type="number" min="0.000001" step="any" value={manualRate} onChange={(event) => setManualRate(event.target.value)} /></label>
        <button className="cc-button cc-button-primary" type="button" disabled={busy || !(Number(manualRate) > 0)} onClick={() => update({ mode: "manual", rate: manualRate })}>保存系数</button>
      </> : <button className="cc-button cc-button-secondary" type="button" disabled={busy} onClick={() => update({ mode: "auto", force: true })}><RefreshCw size={15} />{busy ? "获取中…" : "更新汇率"}</button>}
      <strong>{rate ? `1 USD = ${Number(rate.rate.toPrecision(8))} CNY` : "暂未取得系数"}</strong>
    </div>
    <div className="profile-meta">
      {rate && <><span>来源：{source}</span><span>数据日期：{rate.rateDate}</span><span>{rate.source === "manual" ? "设置" : "获取"}时间：{formatTime(rate.fetchedAt)}</span></>}
      {value?.mode === "auto" && <span>每 24 小时更新，非工作日沿用最近公布值</span>}
    </div>
    {(error || value?.lastError) && <p className="price-lab-error" role="status">{error || `获取失败：${value.lastError}`}。{rate ? "保留上次成功系数，可手动重试或设置。" : "参考换算暂不可用，仍可记录原币金额。"}</p>}
    {value?.stale && rate && <p className="price-lab-error">缓存已超过 24 小时，当前沿用上次成功系数。</p>}
  </article>;
}
