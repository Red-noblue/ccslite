/** 展示请求开始时的候选、排除原因、供应商尝试与 SSE 完整性证据。 */
import { useEffect, useState } from "react";
import { routeReasonText, exclusionText, attemptStage, requestOutcome, requestExplanation } from "./request-diagnostics.js";

function RecoveryHistory({ log, apiClient }) {
  const [data, setData] = useState(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const day = (log.requestStartedAt || log.timestamp || "").slice(0, 10);
  async function load(page = 1) {
    setLoading(true); setError("");
    try { setData(await apiClient(`/api/routing/recovery-events?${new URLSearchParams({ groupId: log.groupId || "default", day, page })}`)); }
    catch { setError("当日事件暂时无法读取，请重试。"); }
    finally { setLoading(false); }
  }
  return <details className="recovery-history"><summary>同组当日恢复事件（UTC {day}）</summary>
    <p>这里包含全组事件，不代表它们都由本次请求触发。归档不会自动删除。</p>
    {!data && <button type="button" className="cc-button cc-button-secondary cc-button-sm" disabled={loading} onClick={() => load()}>{loading ? "正在读取…" : "读取当日事件"}</button>}
    {error && <p role="alert">{error}</p>}
    {data && <>
      <p>共 {data.total} 项 · 第 {data.page} 页</p>
      <ol>{data.events.map((event) => <li key={event.eventId}><time>{new Date(event.timestamp).toLocaleString("zh-CN")}</time> · {event.providerName} · {event.model} · {event.kind === "confirmed" ? `确认可用（${event.successCount} 次成功）` : event.kind === "bindings_migrated" ? `迁移 ${event.migratedBindings} 个绑定` : "恢复确认失效（失败或配置变化）"}</li>)}</ol>
      {data.total > 30 && <div className="compatibility-pagination"><button type="button" className="cc-button cc-button-secondary cc-button-sm" disabled={loading || data.page <= 1} onClick={() => load(data.page - 1)}>上一页</button><button type="button" className="cc-button cc-button-secondary cc-button-sm" disabled={loading || data.page * 30 >= data.total} onClick={() => load(data.page + 1)}>下一页</button></div>}
    </>}
  </details>;
}

export function RequestDiagnostics({ log, apiClient }) {
  const [evidence, setEvidence] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setEvidence(null); setError(""); }, [log.id]);
  async function loadEvidence() {
    if (loading) return;
    setLoading(true); setError("");
    try { setEvidence(await apiClient(`/api/billing/logs/${encodeURIComponent(log.id)}/evidence?groupId=${encodeURIComponent(log.groupId || "default")}`)); }
    catch { setError("证据读取失败，请重试；不会重新请求供应商。"); }
    finally { setLoading(false); }
  }
  const snapshot = log.routeSnapshot;
  const attempts = log.providerAttempts || [];
  const providerName = (id) => [...(snapshot?.candidates || []), ...(snapshot?.excluded || [])].find((provider) => provider.providerId === id)?.providerName || id;
  return <div className="request-diagnostics">
    <section className="request-explanation" aria-label="请求过程说明"><h4>这次请求发生了什么</h4><ol>{requestExplanation(log).map((line, index) => <li key={index}>{line}</li>)}</ol></section>
    <p><strong>{requestOutcome(log)}</strong> · {routeReasonText(log.routeReason)} · 最终供应商：{log.providerName || "未选择"}</p>
    <p className="mono">请求 ID：{log.requestId || "未记录"}</p>
    {log.failureClass && <p>失败类型：{log.failureClass}</p>}
    <h4>请求开始时的路由</h4>
    {snapshot ? <>
      <p>{snapshot.mode === "manual" ? "单供应商模式" : "自动路由"} · 入口 {snapshot.routeKey} · 模型 {snapshot.model || "未指定"}</p>
      {snapshot.stickyProviderId && <p>进入请求时的粘滞供应商：{providerName(snapshot.stickyProviderId)}</p>}
      {snapshot.contextProviderId && <p>旧响应所属供应商：{providerName(snapshot.contextProviderId)}；优先保留该响应的上下文。</p>}
      <p>候选顺序：{snapshot.candidates.map((provider) => `${provider.providerName}（P${provider.priority}）`).join(" → ") || "无可用候选"}</p>
      <p>候选不代表全部尝试；粘滞、恢复确认和响应上下文可能调整顺序。</p>
      {snapshot.excluded.length > 0 && <ul>{snapshot.excluded.map((provider) => <li key={provider.providerId}>{provider.providerName}：{exclusionText(provider.reason)}</li>)}</ul>}
      {snapshot.omittedCount > 0 && <p>另有 {snapshot.omittedCount} 项未保存。</p>}
    </> : <p>当时未记录候选快照，无法还原当时的开关和排除原因。</p>}
    <h4>实际尝试链</h4>
    {attempts.length ? <ol>{attempts.map((attempt, index) => <li key={index}>
      <strong>{attempt.providerName}</strong> · {attemptStage(attempt)} · HTTP {attempt.statusCode || "未收到"} · {attempt.latencyMs} ms
      {attempt.failureClass && <span> · {attempt.failureClass}</span>}
      {attempt.retryDelayMs > 0 && <span> · 重试等待 {attempt.retryDelayMs} ms</span>}
      {attempt.streamDiagnostics && <p>
        首字节 {attempt.streamDiagnostics.firstByteLatencyMs ?? "未记录"} ms · 已转发 {attempt.streamDiagnostics.forwardedBytes} 字节 · 结束原因 {attempt.streamDiagnostics.termination || "未记录"} · 完成事件{attempt.streamDiagnostics.events?.completed ? "已收到" : "未收到"}
      </p>}
    </li>)}</ol> : <p>当时未记录尝试链。</p>}
    <section className="request-evidence" aria-label="恢复与能力证据">
      <h4>恢复与能力证据</h4>
      <p>恢复确认、绑定迁移和业务实际使用分别取证。关联报告必须在此请求开始前完成，且分组、模型、配置摘要相同；不会用当前配置补造历史。</p>
      {!evidence && <button type="button" className="cc-button cc-button-secondary cc-button-sm" disabled={loading || !apiClient} onClick={loadEvidence}>{loading ? "正在读取…" : "查看关联证据（不发起模型请求）"}</button>}
      {error && <p role="alert">{error}</p>}
      {evidence && <>
        {evidence.recoveries.length ? <ol className="recovery-evidence-list">{evidence.recoveries.map((event) => <li key={event.eventId}>
          <time>{new Date(event.timestamp).toLocaleString("zh-CN")}</time> · <strong>{event.providerName}</strong> · {event.model}：
          {event.kind === "confirmed" ? `已确认可用（${event.source === "manual" ? "手动检测" : event.source === "business" ? "业务请求" : "后台探测"}，累计 ${event.successCount} 次成功）` : event.kind === "bindings_migrated" ? `已迁移 ${event.migratedBindings} 个会话绑定；等待后续请求实际执行` : "恢复确认已失效"}
        </li>)}</ol> : <p>本次请求未关联可读取的恢复事件；不能据此断言发生过恢复或迁移。</p>}
        {evidence.unavailableRecoveries > 0 && <p>有 {evidence.unavailableRecoveries} 项历史事件无法读取；本次尝试链仍按原记录展示。</p>}
        {log.routeSnapshot?.recovery && <p>本次实际结果：{log.providerAttempts?.at(-1)?.outcome === "success" && log.providerId === log.routeSnapshot.recovery.providerId ? "已由当时确认恢复的供应商成功处理。" : "未记录到由该恢复供应商最终成功处理；请以实际尝试链为准。"}</p>}
        {evidence.reports.map((item, index) => <div className="request-linked-report" key={index}>
          <strong>{item.providerName}</strong>
          {!item.reports.length && <p>{item.association === "not_recorded" ? "当时未记录配置摘要或时间，无法准确关联报告。" : item.association === "unavailable" ? "能力报告暂时不可读取。" : "没有找到请求开始前、同模型同配置的检查报告。"}</p>}
          {item.reports.map((report) => <div key={report.reportId}>
            <p>{report.mode === "development" ? "开发任务检查" : "基础兼容检查"} · {new Date(report.checkedAt).toLocaleString("zh-CN")} · {({ passed: "通过", failed: "未通过", inconclusive: "未完成", cancelled: "已取消" })[report.outcome] || "未记录"}</p>
            <p>{report.readiness === "verified_for_this_task" ? "该配置完成过受控开发任务；不保证本次请求或完整客户端兼容。" : report.mode === "basic" ? "基础通过与否均不代表开发任务已就绪。" : "此报告不能作为开发任务已验证的证据。"}</p>
          </div>)}
          {item.searchTruncated && <p>仅检索最近 200 份报告，未扫描更早归档。</p>}
        </div>)}
        {!evidence.reports.length && <p>本次没有可关联的实际供应商尝试。</p>}
        <RecoveryHistory log={log} apiClient={apiClient} />
      </>}
    </section>
  </div>;
}
