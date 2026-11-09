/**
 * 服务器版 UsageDashboard。
 * 迁移 ccswitch 用量页的 Hero、统计表和请求日志外观，数据改为读取 /api/billing/*。
 */
import { Activity, ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ChevronRight, Coins, Database, RefreshCw, TrendingUp, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCompactNumber, formatMoney, formatNumber, formatTime } from "./format.js";
import { InfoHint } from "./InfoHint.jsx";
import { PriceLab } from "./PriceLab.jsx";

export function UsageDashboard({
  groupId = "default",
  billing,
  providers = [],
  providerFilter,
  onProviderFilterChange,
  pricing,
  setPricing,
  onSavePricing,
  onRefresh,
  apiClient,
  initialSection = "stats",
}) {
  const [activeSection, setActiveSection] = useState(initialSection);
  const [statusFilter, setStatusFilter] = useState("all");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [rangeSummary, setRangeSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [trend, setTrend] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const summaryQuery = useMemo(() => {
    const query = new URLSearchParams({ timezoneOffset: String(new Date().getTimezoneOffset()) });
    if (providerFilter?.id) query.set("providerId", providerFilter.id);
    if (startAt) query.set("startAt", new Date(startAt).toISOString());
    if (endAt) query.set("endAt", new Date(endAt).toISOString());
    return query.toString();
  }, [providerFilter?.id, startAt, endAt]);
  useEffect(() => {
    if (activeSection !== "stats") return;
    setTrend(null);
    let controller;
    const load = async () => {
      if (document.hidden) return;
      controller?.abort(); controller = new AbortController();
      const signal = controller.signal;
      try {
        const query = new URLSearchParams(summaryQuery); query.set("timezoneOffset", String(new Date().getTimezoneOffset()));
        const [summary, nextTrend] = await Promise.all([
          apiClient(`/api/billing/summary?${query}`, { signal }),
          apiClient(`/api/billing/trend?${query}`, { signal }),
        ]);
        if (signal.aborted) return;
        setRangeSummary({ query: summaryQuery, data: summary }); setTrend(nextTrend); setSummaryError("");
      } catch (error) { if (error.name !== "AbortError") setSummaryError(error.message); }
    };
    load(); const timer = setInterval(load, 5000);
    const visible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [summaryQuery, apiClient, groupId, activeSection, refreshToken]);
  // 汇总由后端对全部历史计算，不能用日志表最近 5000 条推算累计用量。
  const filteredBilling = rangeSummary?.query === summaryQuery
    ? rangeSummary.data
    : (!providerFilter?.id && !startAt && !endAt ? billing : null) || emptyUsageSummary();
  const businessBilling = filteredBilling.business || filteredBilling;
  const ccokBilling = filteredBilling.ccok || emptyUsageSummary();
  const usageProviders = businessBilling.providers || [];
  const models = businessBilling.models || [];
  const dayRows = businessBilling.days || [];
  const usageFilterProviders = providers;
  const priceLabProviderFilter = providers.some((provider) => provider.id === providerFilter?.id)
    ? providerFilter
    : null;

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  return (
    <section className="usage-dashboard">
      <div className="usage-section-tabs" role="tablist" aria-label="计费与价格功能">
        <button className={activeSection === "stats" ? "active" : ""} type="button" onClick={() => setActiveSection("stats")}>请求统计</button>
        <button className={activeSection === "experiment" ? "active" : ""} type="button" onClick={() => setActiveSection("experiment")}>价格实验</button>
        <button className={activeSection === "calibration" ? "active" : ""} type="button" onClick={() => setActiveSection("calibration")}>长期校准</button>
      </div>
      {activeSection === "stats" ? <>
      <div className="usage-toolbar">
        <div>
          <h2>{providerFilter ? `${providerFilter.name} 使用统计` : "使用统计"} <InfoHint>按供应商和时间范围统计请求、Token 与估算成本。</InfoHint></h2>
        </div>
        <div className="usage-toolbar-actions">
          {providerFilter && (
            <button className="cc-button cc-button-secondary" onClick={() => onProviderFilterChange?.(null)}>
              全部供应商
            </button>
          )}
          <button className="cc-button cc-button-secondary" onClick={() => { onRefresh?.(); setRefreshToken((value) => value + 1); }}>
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
      </div>

      <UsageFilters
        providers={usageFilterProviders}
        providerFilter={providerFilter}
        onProviderFilterChange={onProviderFilterChange}
        startAt={startAt}
        endAt={endAt}
        setStartAt={setStartAt}
        setEndAt={setEndAt}
      />

      <UsageHero billing={businessBilling} providerFilter={providerFilter} />
      {summaryError && <p role="alert">统计读取失败：{summaryError}</p>}

      <CcokUsagePanel summary={ccokBilling} />

      <UsageTrendChart trend={trend} />

      <div className="usage-grid">
        <DailyUsageTable rows={dayRows} />
        <UsageStatsTable title="供应商统计" firstColumn="Provider" rows={usageProviders} />
      </div>

      <div className="usage-grid">
        <UsageStatsTable title="模型统计" firstColumn="Model" rows={models} />
        <PricingPanel pricing={pricing} setPricing={setPricing} onSavePricing={onSavePricing} />
      </div>

      <div className="usage-grid">
        <RequestLogTable key={summaryQuery} apiClient={apiClient} query={summaryQuery} refreshToken={refreshToken} statusFilter={statusFilter} setStatusFilter={setStatusFilter} />
      </div>
      </> : (
        <PriceLab
          providers={providers}
          apiClient={apiClient}
          providerFilter={priceLabProviderFilter}
          mode={activeSection === "calibration" ? "calibration" : "experiment"}
        />
      )}
    </section>
  );
}

function UsageFilters({
  providers,
  providerFilter,
  onProviderFilterChange,
  startAt,
  endAt,
  setStartAt,
  setEndAt,
}) {
  return (
    <article className="usage-card usage-filter-card">
      <div className="usage-filter-grid">
        <label>
          <span>供应商</span>
          <select
            value={providerFilter?.id || "all"}
            onChange={(event) => {
              const next = providers.find((provider) => provider.id === event.target.value);
              onProviderFilterChange?.(next ? { id: next.id, name: next.name } : null);
            }}
          >
            <option value="all">全部供应商</option>
            {providers.map((provider) => (
              <option value={provider.id} key={provider.id}>{provider.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>开始时间</span>
          <input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} />
        </label>
        <label>
          <span>结束时间</span>
          <input type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.target.value)} />
        </label>
        <div className="usage-filter-actions">
          <button className="cc-button cc-button-secondary" type="button" onClick={() => applyToday(setStartAt, setEndAt)}>今天</button>
          <button className="cc-button cc-button-secondary" type="button" onClick={() => applyLastDays(setStartAt, setEndAt, 7)}>近 7 天</button>
          <button className="cc-button cc-button-secondary" type="button" onClick={() => { setStartAt(""); setEndAt(""); }}>全部时间</button>
        </div>
      </div>
    </article>
  );
}

function UsageTrendChart({ trend }) {
  const chart = useMemo(() => buildTrendChart(formatTrendPoints(trend)), [trend]);
  const [hoveredKey, setHoveredKey] = useState(null);
  const hoveredPoint = chart.points.find((point) => point.key === hoveredKey) || null;

  return (
    <article className="usage-card usage-trend-card">
      <div className="usage-card-head">
        <div>
      <h3>使用趋势 <InfoHint>按时间聚合请求，展示输入、输出、缓存命中与成本变化。</InfoHint></h3>
        </div>
        <span className="state-pill ok">
          <TrendingUp size={13} />
          最近 {formatNumber(trend?.sampleCount || 0)} 条
        </span>
      </div>
      <div className="usage-trend-legend">
        <TrendLegend color="#3b82f6" label="输入 Tokens" />
        <TrendLegend color="#22c55e" label="输出 Tokens" />
        <TrendLegend color="#f97316" label="缓存写入" />
        <TrendLegend color="#8b5cf6" label="缓存命中" />
        <TrendLegend color="#f43f5e" label="成本" dashed />
      </div>
      {chart.points.length ? (
        <div className="usage-trend-chart-wrap" onMouseLeave={() => setHoveredKey(null)}>
          <svg className="usage-trend-svg" viewBox="0 0 760 300" role="img" aria-label="使用趋势">
            <defs>
              <linearGradient id="trendInput" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity="0.22" />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="trendOutput" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity="0.2" />
                <stop offset="95%" stopColor="#22c55e" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="trendCacheWrite" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f97316" stopOpacity="0.18" />
                <stop offset="95%" stopColor="#f97316" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="trendCacheRead" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8b5cf6" stopOpacity="0.18" />
                <stop offset="95%" stopColor="#8b5cf6" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g className="trend-grid">
              {[0, 1, 2, 3].map((item) => (
                <line key={item} x1="56" x2="704" y1={44 + item * 58} y2={44 + item * 58} />
              ))}
            </g>
            <text className="trend-axis-label" x="18" y="48">{formatCompactNumber(chart.tokenMax)}</text>
            <text className="trend-axis-label" x="24" y="224">0</text>
            <text className="trend-axis-label right" x="724" y="48">{formatMoney(chart.costMax, 2)}</text>
            <text className="trend-axis-label right" x="724" y="224">$0</text>
            <TrendArea areaPath={chart.paths.inputArea} linePath={chart.paths.inputLine} color="#3b82f6" fill="url(#trendInput)" />
            <TrendArea areaPath={chart.paths.outputArea} linePath={chart.paths.outputLine} color="#22c55e" fill="url(#trendOutput)" />
            <TrendArea areaPath={chart.paths.cacheCreationArea} linePath={chart.paths.cacheCreationLine} color="#f97316" fill="url(#trendCacheWrite)" />
            <TrendArea areaPath={chart.paths.cacheReadArea} linePath={chart.paths.cacheReadLine} color="#8b5cf6" fill="url(#trendCacheRead)" />
            <path className="trend-line cost" d={chart.paths.costLine} />
            {hoveredPoint && <TrendHoverMarks point={hoveredPoint} />}
            {chart.points.map((point) => (
              <g key={point.key}>
                <circle className="trend-point" cx={point.x} cy={point.inputY} r="3" />
                <text className="trend-x-label" x={point.x} y="270">{point.shortLabel}</text>
                <rect
                  className="trend-hover-zone"
                  x={point.x - chart.hoverBandWidth / 2}
                  y="26"
                  width={chart.hoverBandWidth}
                  height="226"
                  onMouseEnter={() => setHoveredKey(point.key)}
                  onMouseMove={() => setHoveredKey(point.key)}
                />
              </g>
            ))}
          </svg>
          {hoveredPoint && <TrendTooltip point={hoveredPoint} />}
        </div>
      ) : (
        <div className="trend-empty">暂无请求趋势数据</div>
      )}
    </article>
  );
}

function TrendLegend({ color, label, dashed = false }) {
  return (
    <span>
      <i style={{ backgroundColor: dashed ? "transparent" : color, borderColor: color, borderStyle: dashed ? "dashed" : "solid" }} />
      {label}
    </span>
  );
}

function TrendArea({ areaPath, linePath, color, fill }) {
  return (
    <>
      <path className="trend-area" d={areaPath} fill={fill} />
      <path className="trend-line" d={linePath} style={{ stroke: color }} />
    </>
  );
}

function TrendHoverMarks({ point }) {
  return (
    <g className="trend-hover-marks">
      <line className="trend-crosshair" x1={point.x} x2={point.x} y1="34" y2="232" />
      <circle className="trend-focus-point input" cx={point.x} cy={point.inputY} r="4" />
      <circle className="trend-focus-point output" cx={point.x} cy={point.outputY} r="4" />
      <circle className="trend-focus-point cache-write" cx={point.x} cy={point.cacheCreationY} r="4" />
      <circle className="trend-focus-point cache-read" cx={point.x} cy={point.cacheReadY} r="4" />
      <circle className="trend-focus-point cost" cx={point.x} cy={point.costY} r="4" />
    </g>
  );
}

function TrendTooltip({ point }) {
  const left = Math.max(12, Math.min(70, (point.x / 760) * 100));
  return (
    <div className="usage-trend-tooltip" style={{ left: `${left}%` }}>
      <strong>{point.label}</strong>
      <span>输入：{formatNumber(point.inputTokens)}</span>
      <span>输出：{formatNumber(point.outputTokens)}</span>
      <span>缓存写入：{formatNumber(point.cacheCreationTokens)}</span>
      <span>缓存命中：{formatNumber(point.cacheReadTokens)}</span>
      <span>成本：{formatMoney(point.cost, 4)}</span>
    </div>
  );
}

function buildTrendChart(values) {
  const top = 34;
  const bottom = 232;
  const left = 56;
  const right = 704;
  const chartWidth = right - left;
  const chartHeight = bottom - top;
  const tokenMax = Math.max(
    1,
    ...values.flatMap((item) => [
      item.inputTokens,
      item.outputTokens,
      item.cacheCreationTokens,
      item.cacheReadTokens,
    ]),
  );
  const costMax = Math.max(0.000001, ...values.map((item) => item.cost));
  const points = values.map((item, index) => {
    const x = values.length === 1
      ? left + chartWidth / 2
      : left + (chartWidth * index) / (values.length - 1);
    const tokenY = (value) => bottom - (Number(value || 0) / tokenMax) * chartHeight;
    const costY = bottom - (Number(item.cost || 0) / costMax) * chartHeight;
    return {
      ...item,
      x,
      inputY: tokenY(item.inputTokens),
      outputY: tokenY(item.outputTokens),
      cacheCreationY: tokenY(item.cacheCreationTokens),
      cacheReadY: tokenY(item.cacheReadTokens),
      costY,
      tooltip: `${item.label}\n输入 ${formatNumber(item.inputTokens)}\n输出 ${formatNumber(item.outputTokens)}\n缓存读 ${formatNumber(item.cacheReadTokens)}\n缓存写 ${formatNumber(item.cacheCreationTokens)}\n成本 ${formatMoney(item.cost, 4)}`,
    };
  });
  return {
    points,
    tokenMax,
    costMax,
    hoverBandWidth: Math.max(18, Math.min(72, chartWidth / Math.max(1, points.length))),
    paths: {
      inputLine: buildLinePath(points, "inputY"),
      outputLine: buildLinePath(points, "outputY"),
      cacheCreationLine: buildLinePath(points, "cacheCreationY"),
      cacheReadLine: buildLinePath(points, "cacheReadY"),
      costLine: buildLinePath(points, "costY"),
      inputArea: buildAreaPath(points, "inputY", bottom),
      outputArea: buildAreaPath(points, "outputY", bottom),
      cacheCreationArea: buildAreaPath(points, "cacheCreationY", bottom),
      cacheReadArea: buildAreaPath(points, "cacheReadY", bottom),
    },
  };
}

function formatTrendPoints(trend) {
  return (trend?.points || []).map((bucket, index, list) => {
    const date = new Date(bucket.time);
    const label = trend.bucketMs >= 86_400_000
      ? date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
      : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    return { ...bucket, label, shortLabel: compactTrendLabel(label, index, list.length) };
  });
}

function compactTrendLabel(label, index, total) {
  if (total > 10 && index % Math.ceil(total / 8) !== 0 && index !== total - 1) return "";
  return label.replace(/^\d{2}\//, "");
}

function buildLinePath(points, yKey) {
  if (!points.length) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${roundSvg(point.x)} ${roundSvg(point[yKey])}`).join(" ");
}

function buildAreaPath(points, yKey, baseline) {
  if (!points.length) return "";
  const line = buildLinePath(points, yKey);
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L ${roundSvg(last.x)} ${baseline} L ${roundSvg(first.x)} ${baseline} Z`;
}

function roundSvg(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function UsageHero({ billing, providerFilter }) {
  return (
    <article className="usage-hero">
      <div className="usage-hero-top">
        <div className="usage-hero-title">
          <div className="usage-hero-icon">
            <Zap size={21} />
          </div>
          <div>
            <span>{providerFilter ? `${providerFilter.name} · Codex` : "全部应用 · Codex"}</span>
            <strong>{formatCompactNumber(billing?.totalTokens)} Tokens</strong>
          </div>
        </div>
        <div className="usage-hero-side">
          <span>{formatNumber(billing?.totalRequests)} 请求</span>
          <strong>{formatMoney(billing?.estimatedCostUsd)}</strong>
        </div>
      </div>

      <div className="usage-token-row">
        <TokenMetric icon={<ArrowDownToLine size={15} />} label="输入" value={billing?.inputTokens} />
        <TokenMetric icon={<ArrowUpFromLine size={15} />} label="输出" value={billing?.outputTokens} />
        <TokenMetric icon={<Database size={15} />} label="缓存读取" value={billing?.cacheReadTokens} />
        <TokenMetric icon={<Activity size={15} />} label="成功请求" value={billing?.successRequests} />
      </div>
    </article>
  );
}

// CCOK 探测统计面板：保留真实供应商归属，同时将探测流量与业务流量分开显示。
function CcokUsagePanel({ summary }) {
  const providers = summary?.providers || [];
  const models = summary?.models || [];
  return (
    <article className="usage-card ccok-usage-card">
      <div className="usage-card-head">
        <div>
          <h3>CCOK 探测统计 <InfoHint>探测请求仍归属于实际目标供应商；这里单独统计探测产生的请求、Token 和估算成本。</InfoHint></h3>
          <p>不计入上方业务请求统计。</p>
        </div>
        <span className="state-pill neutral">{formatNumber(summary?.totalRequests)} 次</span>
      </div>
      <div className="usage-token-row ccok-token-row">
        <TokenMetric icon={<Activity size={15} />} label="探测请求" value={summary?.totalRequests} />
        <TokenMetric icon={<Database size={15} />} label="总 Tokens" value={summary?.totalTokens} />
        <TokenMetric icon={<ArrowDownToLine size={15} />} label="输入" value={summary?.inputTokens} />
        <TokenMetric icon={<Coins size={15} />} label="估算成本" value={formatMoney(summary?.estimatedCostUsd, 6)} textValue />
      </div>
      <div className="ccok-breakdown-grid">
        <CcokBreakdownTable title="按供应商" rows={providers} />
        <CcokBreakdownTable title="按模型" rows={models} />
      </div>
    </article>
  );
}

function CcokBreakdownTable({ title, rows }) {
  return (
    <div className="ccok-breakdown">
      <h4>{title}</h4>
      <div className="cc-table">
        <table>
          <thead>
            <tr>
              <th>{title === "按供应商" ? "供应商" : "模型"}</th>
              <th className="right">请求</th>
              <th className="right">Tokens</th>
              <th className="right">成本</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.slice(0, 12).map((row) => (
              <tr key={row.name}>
                <td className="strong">{row.name}</td>
                <td className="right">{formatNumber(row.requests)}</td>
                <td className="right">{formatNumber(row.totalTokens)}</td>
                <td className="right">{formatMoney(row.estimatedCostUsd, 6)}</td>
              </tr>
            )) : <tr><td colSpan="4" className="empty-cell">暂无 CCOK 探测记录</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DailyUsageTable({ rows }) {
  return (
    <article className="usage-card">
      <h3>每日统计</h3>
      <div className="cc-table">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th className="right">请求数</th>
              <th className="right">输入</th>
              <th className="right">输出</th>
              <th className="right">Tokens</th>
              <th className="right">成本</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={row.name}>
                <td className="strong">{row.name}</td>
                <td className="right">{formatNumber(row.requests)}</td>
                <td className="right">{formatNumber(row.inputTokens)}</td>
                <td className="right">{formatNumber(row.outputTokens)}</td>
                <td className="right">{formatNumber(row.totalTokens)}</td>
                <td className="right">{formatMoney(row.estimatedCostUsd, 4)}</td>
              </tr>
            )) : <tr><td colSpan="6" className="empty-cell">暂无数据</td></tr>}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function TokenMetric({ icon, label, value, textValue = false }) {
  return (
    <div className="usage-token-metric">
      <span>{icon}{label}</span>
      <strong>{textValue ? value : formatNumber(value)}</strong>
    </div>
  );
}

function UsageStatsTable({ title, firstColumn, rows }) {
  return (
    <article className="usage-card">
      <h3>{title}</h3>
      <div className="cc-table">
        <table>
          <thead>
            <tr>
              <th>{firstColumn}</th>
              <th className="right">请求数</th>
              <th className="right">Tokens</th>
              <th className="right">成本</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.slice(0, 12).map((row) => (
              <tr key={row.name}>
                <td className="strong">{row.name}</td>
                <td className="right">{formatNumber(row.requests)}</td>
                <td className="right">{formatNumber(row.totalTokens)}</td>
                <td className="right">{formatMoney(row.estimatedCostUsd, 4)}</td>
              </tr>
            )) : <tr><td colSpan="4" className="empty-cell">暂无数据</td></tr>}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function PricingPanel({ pricing, setPricing, onSavePricing }) {
  return (
    <article className="usage-card">
      <div className="usage-card-head">
        <div>
          <h3>价格配置 <InfoHint>单位为 USD / 百万 Token；gpt-5.4 / gpt-5.5 按 gpt-5.5 价格估算，Fast 模式按 2.5 倍计费。</InfoHint></h3>
        </div>
        <button className="cc-button cc-button-primary" onClick={onSavePricing}>
          <Coins size={15} />
          保存
        </button>
      </div>
      <div className="cc-table">
        <table>
          <thead>
            <tr>
              <th>模型</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存读</th>
              <th>缓存写</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pricing.map((row, index) => (
              <tr key={index}>
                <td><input value={row.model} onChange={(event) => updateRow(index, "model", event.target.value)} placeholder="gpt-5 或 *" /></td>
                <td><input type="number" min="0" step="0.000001" value={row.inputPerMillion} onChange={(event) => updateRow(index, "inputPerMillion", event.target.value)} /></td>
                <td><input type="number" min="0" step="0.000001" value={row.outputPerMillion} onChange={(event) => updateRow(index, "outputPerMillion", event.target.value)} /></td>
                <td><input type="number" min="0" step="0.000001" value={row.cacheReadPerMillion} onChange={(event) => updateRow(index, "cacheReadPerMillion", event.target.value)} /></td>
                <td><input type="number" min="0" step="0.000001" value={row.cacheCreationPerMillion} onChange={(event) => updateRow(index, "cacheCreationPerMillion", event.target.value)} /></td>
                <td><button className="cc-button cc-button-secondary" onClick={() => setPricing((items) => items.filter((_, i) => i !== index))}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="cc-button cc-button-secondary add-row" onClick={() => setPricing((items) => [...items, { model: "", inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheCreationPerMillion: 0 }])}>添加价格行</button>
    </article>
  );

  function updateRow(index, key, value) {
    setPricing((items) => items.map((item, i) => i === index ? { ...item, [key]: value } : item));
  }
}

function RequestLogTable({ apiClient, query, refreshToken, statusFilter, setStatusFilter }) {
  const pageSize = 30;
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const snapshot = useRef("");
  const totalPages = data?.totalPages || 1;
  const currentPage = page;
  const pageLogs = data?.records || [];
  const total = data?.totalRecords || 0;
  useEffect(() => { setPage(0); snapshot.current = ""; }, [refreshToken]);
  useEffect(() => {
    let controller;
    const load = async () => {
      if (document.hidden) return;
      controller?.abort(); controller = new AbortController();
      const signal = controller.signal;
      const params = new URLSearchParams(query);
      params.set("page", String(page + 1)); params.set("pageSize", String(pageSize)); params.set("status", statusFilter);
      if (page > 0 && snapshot.current) params.set("snapshot", snapshot.current);
      try {
        const result = await apiClient(`/api/billing/logs?${params}`, { signal });
        if (signal.aborted) return;
        snapshot.current = result.snapshot; setData(result); setError("");
        if (result.page !== page + 1) setPage(result.page - 1);
      } catch (failure) {
        if (failure.name === "AbortError") return;
        if (failure.status === 409) { snapshot.current = ""; setPage(0); }
        setError(failure.message);
      }
    };
    load(); const timer = page === 0 ? setInterval(load, 5000) : null;
    const visible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [apiClient, query, page, statusFilter, refreshToken]);

  return (
    <article className="usage-card">
      <div className="usage-card-head">
        <div>
          <h3>请求日志 <InfoHint>每页显示 30 条请求。</InfoHint></h3>
        </div>
        <span className="state-pill neutral">{formatNumber(total)} 条</span>
      </div>
      <div className="usage-log-filters">
        <select value={statusFilter} onChange={(event) => { setPage(0); snapshot.current = ""; setStatusFilter(event.target.value); }}>
          <option value="all">全部状态</option>
          <option value="200">200 OK</option>
          <option value="400">400</option>
          <option value="401">401</option>
          <option value="429">429</option>
          <option value="500">500</option>
          <option value="502">502</option>
          <option value="503">503</option>
        </select>
      </div>
      {error && <p role="alert">日志读取失败：{error}</p>}
      <div className="cc-table">
        <table>
          <thead>
            <tr>
              <th className="center">时间</th>
              <th className="center">供应商</th>
              <th className="center">模型</th>
              <th className="center">计费模型</th>
              <th className="center">模式</th>
              <th className="center">输入</th>
              <th className="center">输出</th>
              <th className="center">成本</th>
              <th className="center">状态</th>
              <th className="center">请求 ID</th>
            </tr>
          </thead>
          <tbody>
            {pageLogs.length ? pageLogs.map((log) => (
              <tr key={log.id}>
                <td className="center">{formatTime(log.timestamp)}</td>
                <td className="center">
                  <span>{log.providerName || "未知"}</span>
                  {isCcokProbeLog(log) && <span className="usage-category-tag">CCOK</span>}
                </td>
                <td className="center mono">{log.responseModel || log.requestModel || "unknown"}</td>
                <td className="center mono">{log.billingModel || log.responseModel || log.requestModel || "unknown"}</td>
                <td className="center">
                  <span className={`state-pill ${log.billingMode === "fast" ? "warn" : "neutral"}`}>
                    {log.billingMode === "fast" ? `Fast x${log.billingMultiplier || 2.5}` : "标准"}
                  </span>
                </td>
                <td className="center">{formatNumber(log.inputTokens)}</td>
                <td className="center">{formatNumber(log.outputTokens)}</td>
                <td className="center">{formatMoney(log.estimatedCostUsd, 4)}</td>
                <td className="center">
                  <span className={`state-pill ${log.error || log.statusCode >= 400 ? "bad" : "ok"}`}>{log.statusCode}</span>
                </td>
                <td className="center mono" title={log.requestId || ""}>{shortRequestId(log.requestId)}</td>
              </tr>
            )) : <tr><td colSpan="10" className="empty-cell">暂无数据</td></tr>}
          </tbody>
        </table>
      </div>
      <LogPagination
        page={currentPage}
        totalPages={totalPages}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
      />
    </article>
  );
}

function shortRequestId(value) {
  const id = String(value || "");
  return id ? `${id.slice(0, 8)}…` : "-";
}

function LogPagination({ page, totalPages, total, pageSize, onPageChange }) {
  const pages = buildPageItems(page, totalPages);
  return (
    <div className="log-pagination">
      <span>共 {formatNumber(total)} 条 · 每页 {pageSize} 条</span>
      <div className="log-pagination-actions">
        <button className="cc-button cc-button-secondary cc-button-sm" disabled={page === 0} onClick={() => onPageChange(Math.max(0, page - 1))}>
          <ChevronLeft size={14} />
        </button>
        {pages.map((item, index) => item === "ellipsis" ? (
          <span className="pagination-ellipsis" key={`${item}-${index}`}>...</span>
        ) : (
          <button
            className={`page-button ${item === page ? "active" : ""}`}
            key={item}
            onClick={() => onPageChange(item)}
          >
            {item + 1}
          </button>
        ))}
        <button className="cc-button cc-button-secondary cc-button-sm" disabled={page >= totalPages - 1} onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}>
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

function buildPageItems(page, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index);
  }
  const selected = new Set([0, 1, totalPages - 2, totalPages - 1, page - 1, page, page + 1]);
  const sorted = Array.from(selected)
    .filter((item) => item >= 0 && item < totalPages)
    .sort((a, b) => a - b);
  const result = [];
  for (const item of sorted) {
    if (result.length && item - result[result.length - 1] > 1) {
      result.push("ellipsis");
    }
    result.push(item);
  }
  return result;
}


function emptyUsageSummary() {
  return {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    providers: [],
    models: [],
    days: [],
  };
}

function isCcokProbeLog(log) {
  return String(log?.usageCategory || "") === "ccok_probe" ||
    String(log?.endpoint || "").includes("#provider-test");
}



function applyToday(setStartAt, setEndAt) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  setStartAt(toDatetimeLocalValue(start));
  setEndAt(toDatetimeLocalValue(now));
}

function applyLastDays(setStartAt, setEndAt, days) {
  const now = new Date();
  const start = new Date(now.getTime() - Math.max(1, Number(days || 1)) * 24 * 60 * 60 * 1000);
  setStartAt(toDatetimeLocalValue(start));
  setEndAt(toDatetimeLocalValue(now));
}

function toDatetimeLocalValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}
