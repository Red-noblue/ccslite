/** 供应商兼容性检查弹窗：分开检查与历史，集中展示预算、执行状态和真实操作证据。 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, AlertCircle, CheckCircle2, Clock3, Code2, Download, FileText, FlaskConical, History, Loader2, MinusCircle, Play, RefreshCw, ShieldCheck, X, XCircle } from "lucide-react";
import { exportCompatibilityReport, getCompatibilityDefinition } from "../../../lib/compatibility-report-format.js";

const labels = { stream: "流式完整结束", tools: "工具调用往返", context: "响应上下文续接", read: "读取文件", command: "执行命令", create: "创建文件", edit: "修改文件", verify: "命令校验", independent: "独立检查" };
const toolLabels = { read_file: "读取文件", write_file: "写入文件", edit_file: "修改文件", run_command: "执行命令", unknown: "未知工具" };
const outcomes = { passed: "通过", failed: "未通过", inconclusive: "未完成", cancelled: "已取消", skipped: "未取得证据" };
const icons = { passed: CheckCircle2, failed: XCircle, inconclusive: AlertCircle, cancelled: MinusCircle, skipped: MinusCircle };
const modes = {
  development: { label: "开发任务检查", description: "验证模型能否实际完成文件读写和命令任务", budget: "最多 2 分钟 · 8 次请求", icon: Code2 },
  basic: { label: "基础兼容性检查", description: "检查流式响应、工具往返与响应上下文续接", budget: "最多 5 次请求 · 单次 30 秒", icon: Activity },
};
const modeName = (mode) => mode === "development" ? "开发任务" : "基础检查";
const formatDate = (date) => new Date(date).toLocaleString("zh-CN");

const requestSteps = { stream: "检查 SSE 流式结束", tool_call: "发出合成函数调用", tool_result: "回传合成函数结果", context_create: "建立测试上下文", context_continue: "续接测试上下文" };
const requestOutcomes = { completed: "收到完整响应", failed: "响应未通过校验", inconclusive: "请求未完成", cancelled: "请求已取消" };
const requestProtocols = { sse: "SSE 流式", json: "JSON 非流式", other: "其他响应格式", unknown: "未确认响应格式" };
const checkPlans = {
  basic: ["请求流式短答，确认收到 response.completed", "发起合成函数调用，再验证回传结果", "新建一条合成响应，用旧响应 ID 验证续接"],
  development: ["读取 input.json 和 summary.json，执行预置 inspect 命令", "创建 result.json，编辑 summary.json", "执行预置 verify 命令，由 CCSlite 独立验证产物"],
};
const requestStepLabel = (item) => requestSteps[item.step] || (/^development-\d+$/.test(item.step) ? "开发任务往返" : "检查请求");

function CompatibilityExecution({ report }) {
  const traces = report.requestTrace || [];
  const steps = report.steps || [];
  if (!traces.length && !steps.length) return <p className="compatibility-cost">没有逐次请求或工具操作明细；旧报告仍可查看原有结论。</p>;
  const rounds = [...new Set([...traces.map((item) => item.sequence), ...steps.map((item) => item.round)])].sort((a, b) => a - b);
  return <details className="compatibility-details compatibility-evidence" open>
    <summary>执行明细 · {traces.length ? `${traces.length} 次请求` : "未记录请求明细"}{steps.length ? ` · ${steps.length} 项工具操作` : ""}</summary>
    <ol className="compatibility-execution">
      {rounds.map((round) => {
        const trace = traces.find((item) => item.sequence === round);
        const calls = steps.filter((step) => step.round === round);
        return <li className="compatibility-round" key={round}>
          <div className="compatibility-round-head">
            <strong>第 {round} 次请求{trace ? `：${requestStepLabel(trace)}` : ""}</strong>
            {trace && <span>{requestOutcomes[trace.outcome] || "结果未记录"}</span>}
          </div>
          {trace && <small>{requestProtocols[trace.protocol] || requestProtocols.unknown} · {trace.statusCode ? `HTTP ${trace.statusCode}` : "未收到 HTTP 状态"} · {trace.latencyMs} ms · {trace.responseBytes} 字节{trace.firstByteMs != null ? ` · 首字节 ${trace.firstByteMs} ms` : ""}</small>}
          {calls.map((step, index) => <div className="compatibility-tool-step" key={index}>
            <div><strong>{toolLabels[step.tool] || "工具操作"}{step.target && <code>{step.tool === "run_command" ? `node task-check.mjs ${step.target}` : step.target}</code>}</strong>
              <small>{step.detail || step.message}{step.exitCode != null ? ` · 退出码 ${step.exitCode}` : ""}</small></div><Outcome outcome={step.ok ? "passed" : "failed"} />
          </div>)}
        </li>;
      })}
    </ol>
    <p>只显示传输信息和受控操作摘要。上游响应完整与检查通过是两个独立结果。</p>
  </details>;
}

function Outcome({ outcome }) {
  const Icon = icons[outcome] || MinusCircle;
  return <span className={`compatibility-outcome ${outcome || "skipped"}`}><Icon size={15} aria-hidden="true" />{outcomes[outcome] || "已完成"}</span>;
}

function CompatibilityReport({ report, apiClient, base }) {
  const element = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const definition = getCompatibilityDefinition(report);
  useEffect(() => { element.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [report]);
  async function download() {
    if (exporting) return;
    setExporting(true); setExportError("");
    try {
      const exported = report.saved && report.reportId ? await apiClient(`${base}/reports/${encodeURIComponent(report.reportId)}/export`) : exportCompatibilityReport(report);
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2) + "\n"], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `ccslite-${report.mode === "development" ? "development" : "basic"}-${exported.checkedAt?.replace(/\D/g, "") || "report"}.json`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setExportError("报告导出失败，请重试导出；无需重新检查供应商。"); }
    finally { setExporting(false); }
  }
  return <section ref={element} className="compatibility-result" aria-label="检查结果" aria-live="polite">
    <div className="compatibility-result-head">
      <div><span className="compatibility-eyebrow">检查结果</span><h3>{modeName(report.mode)}：{outcomes[report.outcome] || "已完成"}</h3></div>
      <Outcome outcome={report.outcome} />
    </div>
    {report.message && <p className="compatibility-result-message">{report.message}</p>}
    <div className="compatibility-report-meta">
      <span><small>检查模型</small><strong>{report.model}</strong></span>
      <span><small>发起请求</small><strong>已发起 {report.requestCount} 次请求</strong></span>
      <span><small>本次用量</small><strong>{Number(report.usage?.totalTokens || 0).toLocaleString()} Tokens</strong></span>
      {report.latencyMs != null && <span><small>检查耗时</small><strong>{(report.latencyMs / 1000).toFixed(1)} 秒</strong></span>}
      {report.usage && <span><small>用量构成</small><strong>输入 {Number(report.usage.inputTokens || 0).toLocaleString()} · 输出 {Number(report.usage.outputTokens || 0).toLocaleString()}</strong></span>}
    </div>
    <details className="compatibility-details compatibility-report-scope"><summary>{definition ? `Responses · 检查定义 v${definition.version}` : "历史报告未记录检查定义版本"}</summary><div>
      <p>{report.mode === "development" ? "范围：隔离文件的实际读写、两条固定 Node 命令与独立产物校验。通过只表示本次受控任务成功。" : "范围：SSE 完整结束、合成函数往返和响应 ID 续接。基础检查通过不代表开发任务已就绪。"}</p>
      <p>{report.environment ? `执行环境：ccslite ${report.environment.ccsliteVersion} · Node ${report.environment.nodeVersion} · ${report.environment.platform}/${report.environment.arch}` : "此历史报告未记录执行环境。"}</p>
      <p>未执行真实 Codex 或 OpenCode 客户端验收。查看和导出报告不会再次请求供应商。</p>
    </div></details>
    {report.stale && <p className="compatibility-notice warning" role="status"><AlertCircle size={16} />配置已变化，建议重测；此报告对应检查开始时的配置。</p>}
    {report.saved === false && <p className="compatibility-notice warning" role="alert"><AlertCircle size={16} />{report.saveError}</p>}
    {!!report.results?.length && <ul className="compatibility-checklist">{report.results.map((item) => {
      const Icon = icons[item.outcome] || MinusCircle;
      return <li key={item.key}>
        <span className={`compatibility-check-icon ${item.outcome}`}><Icon size={18} aria-hidden="true" /></span>
        <div><strong>{labels[item.key] || item.key}：{outcomes[item.outcome] || item.outcome}</strong><p>{item.message}</p></div>
        {item.latencyMs != null && <small>{item.latencyMs} ms</small>}
      </li>;
    })}</ul>}
    <CompatibilityExecution report={report} />
    <div className="compatibility-report-footer"><time dateTime={report.checkedAt}>{formatDate(report.checkedAt)}</time><span>{report.saved ? "报告已保存" : "报告未保存"}</span><button type="button" className="cc-button cc-button-secondary cc-button-sm compatibility-export" onClick={download} disabled={exporting}><Download size={14} />{exporting ? "正在导出…" : "导出脱敏报告"}</button></div>
    <p className="compatibility-cost">导出 JSON 保留模型、时间、结果和环境版本，移除供应商标识、地址、认证及动态错误文本。</p>
    {exportError && <p className="compatibility-notice warning" role="alert">{exportError}</p>}
  </section>;
}

export function ProviderCompatibility({ provider, apiClient, onClose }) {
  const [model, setModel] = useState(provider.modelSupport?.preferredTestModel || "gpt-6.1-sol");
  const [mode, setMode] = useState("development");
  const [tab, setTab] = useState("check");
  const [pending, setPending] = useState(false);
  const [report, setReport] = useState(null);
  const [historyReport, setHistoryReport] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [history, setHistory] = useState({ reports: [], page: 1, pageSize: 10, total: 0 });
  const controller = useRef(null);
  const mounted = useRef(false);
  const dialog = useRef(null);
  const modelInput = useRef(null);
  const historyVersion = useRef(0);
  const detailVersion = useRef(0);
  const titleId = useId(); const modelId = useId(); const modeId = useId();
  const base = `/api/providers/${encodeURIComponent(provider.id)}/compatibility`;
  const loadHistory = useCallback(async (page = 1) => {
    const version = ++historyVersion.current;
    setHistoryLoading(true); setHistoryError("");
    try {
      const result = await apiClient(`${base}/reports?page=${page}&pageSize=10`);
      if (mounted.current && version === historyVersion.current) setHistory(result);
    } catch (failure) { if (mounted.current && version === historyVersion.current) setHistoryError(`历史报告读取失败：${failure.message}`); }
    finally { if (mounted.current && version === historyVersion.current) setHistoryLoading(false); }
  }, [apiClient, base]);
  useEffect(() => {
    mounted.current = true; loadHistory();
    const previousFocus = document.activeElement;
    const modal = dialog.current;
    modal.showModal(); modelInput.current?.focus();
    return () => {
      mounted.current = false; historyVersion.current += 1; detailVersion.current += 1; controller.current?.abort();
      modal.close(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [loadHistory]);
  useEffect(() => {
    const modal = dialog.current;
    const handleCancel = (event) => { event.preventDefault(); if (!pending) onClose(); };
    // 输入框禁用后焦点可能落到 body；在文档捕获阶段阻止连续 Esc 的默认关闭动作。
    const handleEscape = (event) => { if (pending && event.key === "Escape") event.preventDefault(); };
    modal.addEventListener("cancel", handleCancel);
    document.addEventListener("keydown", handleEscape, true);
    return () => { modal.removeEventListener("cancel", handleCancel); document.removeEventListener("keydown", handleEscape, true); };
  }, [pending, onClose]);
  async function run(event) {
    event.preventDefault();
    if (pending || !model.trim()) return;
    const active = new AbortController(); controller.current = active;
    setPending(true); setError(""); setReport(null);
    try {
      const result = await apiClient(base, { method: "POST", body: JSON.stringify({ model: model.trim(), mode }), signal: active.signal });
      if (mounted.current && !active.signal.aborted) setReport(result);
    } catch (failure) {
      if (mounted.current) setError(active.signal.aborted ? "已请求取消；停止后会保存取消摘要，可在历史报告中刷新查看。" : failure.message);
    } finally {
      if (mounted.current) { setPending(false); await loadHistory(); }
      if (controller.current === active) controller.current = null;
    }
  }
  async function showReport(id) {
    const version = ++detailVersion.current;
    setDetailLoading(true); setHistoryError(""); setHistoryReport(null);
    try {
      const result = await apiClient(`${base}/reports/${encodeURIComponent(id)}`);
      if (mounted.current && version === detailVersion.current) setHistoryReport(result);
    } catch (failure) { if (mounted.current && version === detailVersion.current) setHistoryError(failure.message); }
    finally { if (mounted.current && version === detailVersion.current) setDetailLoading(false); }
  }
  function changePage(page) { detailVersion.current += 1; setHistoryReport(null); setDetailLoading(false); loadHistory(page); }
  return createPortal(<dialog ref={dialog} className="compatibility-dialog" aria-labelledby={titleId}>
    <section className="compatibility-panel">
      <header className="compatibility-header">
        <span className="compatibility-heading-icon"><FlaskConical size={22} aria-hidden="true" /></span>
        <div><h2 id={titleId}>编码兼容性检查</h2><p title={provider.name}>{provider.name}</p></div>
        <button type="button" className="cc-icon-action compatibility-close" aria-label="关闭兼容性检查" title={pending ? "请先取消检查再关闭" : "关闭"} disabled={pending} onClick={onClose}><X size={20} /></button>
      </header>
      <nav className="compatibility-tabs" aria-label="兼容性检查视图">
        <button type="button" aria-pressed={tab === "check"} onClick={() => setTab("check")}><FlaskConical size={16} />开始检查</button>
        <button type="button" aria-pressed={tab === "history"} disabled={pending} onClick={() => setTab("history")}><History size={16} />历史报告<span>{history.total}</span></button>
      </nav>
      <div className="compatibility-body">
        {tab === "check" ? <>
          <form onSubmit={run} className="compatibility-form">
            <fieldset className="compatibility-modes" disabled={pending}><legend>检查类型</legend>
              {Object.entries(modes).map(([key, item]) => { const Icon = item.icon; return <label className={`compatibility-mode ${mode === key ? "selected" : ""}`} key={key}>
                <input type="radio" name={modeId} value={key} checked={mode === key} onChange={() => setMode(key)} />
                <Icon size={20} aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.description}</small><em><Clock3 size={12} />{item.budget}</em></span>
              </label>; })}
            </fieldset>
            <div className="compatibility-model-row"><label htmlFor={modelId}>检查模型<input id={modelId} ref={modelInput} value={model} maxLength={160} placeholder="例如 gpt-6.1-sol" disabled={pending} onChange={(event) => setModel(event.target.value)} /></label>
              {pending ? <button type="button" className="cc-button cc-button-secondary compatibility-start" onClick={() => controller.current?.abort()}>取消检查</button> : <button type="submit" className="cc-button cc-button-primary compatibility-start" disabled={!model.trim()}><Play size={16} />开始{mode === "development" ? "开发任务" : "基础"}检查</button>}
            </div>
            <p className="compatibility-cost">可能产生少量费用，用量计入「使用统计 → 探测统计」。只测试当前供应商，报告自动保存。</p>
            <div className="compatibility-check-plan"><strong>本次会检查什么</strong><ol>{checkPlans[mode].map((item) => <li key={item}>{item}</li>)}</ol></div>
            <details className="compatibility-details"><summary>检查范围与说明</summary><div>
              <p>基础检查分别验证 SSE 完整结束、函数调用往返和响应上下文续接。上下文项需要上游保存合成内容，失败不影响其他检查项。</p>
              <p>开发任务检查使用隔离文件和两条固定 Node 命令，不安装客户端，不执行模型生成的任意命令。通过表示本次任务成功，不代表完全兼容 Codex 或 OpenCode 的全部工具协议。</p>
              <p>检查期间业务继续服务，其他管理修改可能等待。时间或请求预算耗尽会标记“未完成”，不直接判定供应商不支持。</p>
            </div></details>
          </form>
          {pending && <div className="compatibility-running" role="status"><Loader2 size={20} className="spin" /><div><strong>正在进行{modes[mode].label}</strong><p>{modes[mode].budget}，完成后显示逐项结果。可随时取消。</p></div></div>}
          {error && <p className="compatibility-notice warning" role="alert"><AlertCircle size={16} />{error}</p>}
          {report && <CompatibilityReport report={report} apiClient={apiClient} base={base} />}
        </> : <section className="compatibility-history" aria-label="历史报告">
          <div className="compatibility-history-head"><div><h3>历史报告</h3><p>共 {history.total} 份 · 仅当前供应商与当前分组</p></div><button type="button" className="cc-button cc-button-secondary cc-button-sm" onClick={() => loadHistory(history.page)} disabled={historyLoading}><RefreshCw size={14} className={historyLoading ? "spin" : ""} />刷新历史报告</button></div>
          {historyError && <p className="compatibility-notice warning" role="alert"><AlertCircle size={16} />{historyError}</p>}
          {historyLoading && <p className="compatibility-history-status" role="status">正在读取报告…</p>}
          {!historyLoading && !history.total && !historyError && <div className="compatibility-empty"><FileText size={30} /><strong>暂无检查报告</strong><p>完成一次检查后，可在这里查看和对比结果。</p><button type="button" className="cc-button cc-button-secondary cc-button-sm" onClick={() => setTab("check")}>开始首次检查</button></div>}
          {!!history.reports.length && <ul className="compatibility-history-list">{history.reports.map((item) => <li key={item.reportId}><button type="button" aria-pressed={historyReport?.reportId === item.reportId} onClick={() => showReport(item.reportId)}>
            <span className="compatibility-history-icon"><FileText size={18} /></span><span className="compatibility-history-copy"><strong>{modeName(item.mode)} · {item.model}</strong><small><time dateTime={item.checkedAt}>{formatDate(item.checkedAt)}</time> · {item.requestCount} 次请求{item.stale && <em> · 配置已变化</em>}</small></span><Outcome outcome={item.outcome} />
          </button></li>)}</ul>}
          {history.total > history.pageSize && <div className="compatibility-pagination"><span>第 {history.page} 页 · 共 {history.total} 份</span><div><button type="button" className="cc-button cc-button-secondary cc-button-sm" disabled={historyLoading || history.page <= 1} onClick={() => changePage(history.page - 1)}>上一页</button><button type="button" className="cc-button cc-button-secondary cc-button-sm" disabled={historyLoading || history.page * history.pageSize >= history.total} onClick={() => changePage(history.page + 1)}>下一页</button></div></div>}
          {detailLoading && <p role="status" className="compatibility-history-status">正在读取报告详情…</p>}
          {historyReport && <CompatibilityReport report={historyReport} apiClient={apiClient} base={base} />}
        </section>}
      </div>
      <footer className="compatibility-footer"><ShieldCheck size={15} />不修改路由健康、优先级和会话粘滞</footer>
    </section>
  </dialog>, document.body);
}
