/**
 * 服务器版 ProviderCard。
 * 迁移 ccswitch 原版供应商卡片结构，保留供应商图标、故障转移优先级和 hover 操作区外观。
 */
import { useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, ChevronDown, ChevronUp, Eye, EyeOff, Loader2, Save, X, XCircle } from "lucide-react";
import { OAuthFileSourceFields } from "./OAuthFileSourceFields.jsx";
import { ProviderActions } from "./ProviderActions.jsx";
import { formatMoney, formatNumber, formatTime, stateText } from "./format.js";

export function ProviderCard({
  provider,
  isCurrent,
  isAutoFailoverEnabled,
  billingStats,
  testStatus,
  onUpdate,
  onLoadDetails,
  onAction,
  onConfigureUsage,
  onOpenPriceLab,
  onDiscoverOAuthFiles,
  activeRequests = [],
  onCancelRequest,
}) {
  const [sortIndex, setSortIndex] = useState(provider.sortIndex || 1);
  const [expanded, setExpanded] = useState(false);
  const [editDraft, setEditDraft] = useState(() => providerToDraft(provider));
  const [editError, setEditError] = useState("");
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isSummaryKeyVisible, setIsSummaryKeyVisible] = useState(false);
  const [summaryApiKey, setSummaryApiKey] = useState("");
  const [isEditKeyVisible, setIsEditKeyVisible] = useState(false);
  const circuit = provider.circuit || {};
  const circuitClass = circuit.state === "open" ? "bad" : circuit.state === "half_open" ? "warn" : "ok";
  const routingStateClass = provider.routingEnabled ? circuitClass : "neutral";
  const routingStateText = provider.routingEnabled ? stateText(circuit.state) : "未参与本组路由";
  const displayUrl = provider.baseUrl || provider.notes || "未配置接口地址";

  useEffect(() => {
    setSortIndex(provider.sortIndex || 1);
  }, [provider.sortIndex]);

  useEffect(() => {
    setExpanded(false);
    setEditDraft(providerToDraft(provider));
    setEditError("");
    setIsSummaryKeyVisible(false);
    setSummaryApiKey("");
    setIsEditKeyVisible(false);
  }, [provider.id]);

  const usageLine = useMemo(() => {
    if (!billingStats) return "今日暂无用量";
    return `今日 ${formatNumber(billingStats.totalTokens)} Tokens · ${formatMoney(billingStats.estimatedCostUsd, 4)}`;
  }, [billingStats]);

  return (
    <article
      className={`cc-provider-card group ${isCurrent ? "active" : ""}`}
    >
      <div className="active-gradient" />
      <div className="provider-row-main">
        <div className="provider-main-left">
          <div className="provider-avatar">AI</div>

          <div className="provider-identity">
            <div className="provider-name-row">
              <h3>{provider.name}</h3>
              {provider.routingEnabled && (
                <span className="priority-badge">P{provider.sortIndex || 1}</span>
              )}
              {isCurrent && <span className="state-pill ok">使用中</span>}
              <span className={`state-pill ${routingStateClass}`}>
                {routingStateText}
              </span>
            </div>

            <button
              className="provider-url"
              type="button"
              title={displayUrl}
              onClick={() => displayUrl.startsWith("http") && window.open(displayUrl, "_blank", "noreferrer")}
            >
              <span>{displayUrl}</span>
            </button>
          </div>
        </div>

        <div className="provider-main-right">
          <div className="usage-mini">
            <strong>{usageLine}</strong>
            <small className="api-key-summary">
              {provider.authMode === "oauth_file" ? (
                <span>认证：OAuth 文件（动态读取）</span>
              ) : provider.authMode === "client_session" ? (
                <span>认证：客户端会话</span>
              ) : (
                <span>Key: {isSummaryKeyVisible ? summaryApiKey : provider.apiKeyMasked || "未设置"}</span>
              )}
              {provider.authMode === "api_key" && provider.hasApiKey && (
                <button type="button" title={isSummaryKeyVisible ? "隐藏 API Key" : "显示 API Key"} onClick={toggleSummaryKey}>
                  {isSummaryKeyVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              )}
            </small>
          </div>

          <div className="provider-actions-wrap">
            <ProviderActions
              isCurrent={isCurrent}
              isTesting={testStatus?.state === "pending"}
              isAutoFailoverEnabled={isAutoFailoverEnabled}
              isRoutingEnabled={provider.routingEnabled}
              onSwitch={() => onAction(provider, "select")}
              onEdit={toggleEditor}
              onDuplicate={() => duplicateProvider(provider)}
              onTest={() => onAction(provider, "test")}
              onConfigureUsage={onConfigureUsage}
              onOpenPriceLab={onOpenPriceLab}
              onResetCircuit={() => onAction(provider, "reset")}
              onDelete={() => onAction(provider, "delete")}
              onToggleRouting={(routingEnabled) => onUpdate(provider, { routingEnabled })}
            />
          </div>
        </div>
      </div>

      {testStatus && (
        <div className={`provider-test-status ${testStatus.state}`}>
          <div className="provider-test-title">
            {testStatus.state === "pending" ? (
              <Loader2 className="spin" size={14} />
            ) : testStatus.state === "success" ? (
              <CheckCircle2 size={14} />
            ) : (
              <XCircle size={14} />
            )}
            <span>{testStatus.state === "pending" ? "正在等待返回" : testStatus.state === "success" ? "检测成功" : "检测失败"}</span>
          </div>
          <p>{testStatus.message || "无返回消息"}</p>
          <small>
            {testStatus.model ? `模型 ${testStatus.model}` : "模型检测"}
            {testStatus.latencyMs ? ` · ${testStatus.latencyMs}ms` : ""}
            {testStatus.status ? ` · 上游 ${testStatus.status}` : ""}
          </small>
          {testStatus.attempts?.length > 1 && (
            <small className="provider-model-line">
              尝试链路：{testStatus.attempts.map((item) => `${item.model}${item.ok ? "✓" : `(${item.status || "失败"})`}`).join(" -> ")}
            </small>
          )}
          {testStatus.routingMessage && (
            <small className="provider-model-line">路由处理：{testStatus.routingMessage}</small>
          )}
        </div>
      )}

      {activeRequests.length > 0 && (
        <div className="provider-live-requests" aria-live="polite">
          <div className="provider-live-title"><Activity size={14} />活动请求 {activeRequests.length}</div>
          {activeRequests.map((request) => (
            <div className={`provider-live-request${request.stale ? " stale" : ""}`} key={request.id}>
              <div>
                <strong>
                  {request.requestId || request.id.slice(0, 8)}
                  {request.stale && <em className="provider-live-stale">静默超时</em>}
                </strong>
                <small>
                  {({ connecting: "连接上游", probing: "等待有效输出", reading: "读取响应", streaming: "流式传输", cancelling: "正在取消" })[request.state] || request.state} · 已运行 {formatDuration(request.ageMs)} · 最近数据 {request.lastChunkAt ? `${formatDuration(request.idleMs)} 前` : "暂无"}
                  {request.firstByteAt ? ` · 上游首包 ${formatTime(request.firstByteAt)}` : ""}
                  {request.clientFirstByteAt ? ` · 客户端首字节 ${formatTime(request.clientFirstByteAt)}` : ""}
                  {request.lastChunkAt ? ` · 末次 ${formatTime(request.lastChunkAt)}` : ""}
                  {request.noProgressMs != null ? ` · 无有效进展 ${formatDuration(request.noProgressMs)}` : ""}
                </small>
              </div>
              <button
                className="icon-button"
                type="button"
                title="取消这条活动请求"
                aria-label="取消这条活动请求"
                onClick={() => onCancelRequest?.(request)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <ModelSupportSummary support={provider.modelSupport} />

      <div className="provider-inline-controls">
        <label title="控制供应商是否加入自动故障转移队列">
          <input
            type="checkbox"
            checked={Boolean(provider.routingEnabled)}
            onChange={(event) => onUpdate(provider, { routingEnabled: event.target.checked })}
          />
          参与自动路由
        </label>
        <label className="sort-control">
          优先级
          <input
            type="number"
            min="1"
            value={sortIndex}
            onChange={(event) => setSortIndex(event.target.value)}
            onBlur={() => onUpdate(provider, { sortIndex: Number(sortIndex || 1) })}
          />
        </label>
        <button className="expand-button" type="button" onClick={toggleEditor}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          编辑
        </button>
      </div>

      {expanded && (
        <form className="provider-editor" onSubmit={saveDraft}>
          <div className="provider-editor-head">
            <div>
              <h4>供应商配置</h4>
              <p>直接修改本地队列中的供应商配置，保存后立即影响后续请求。</p>
            </div>
            <div className="provider-editor-actions">
              <button className="cc-button cc-button-secondary cc-button-sm" type="button" onClick={() => setExpanded(false)}>
                <X size={14} />
                取消
              </button>
              <button className="cc-button cc-button-primary cc-button-sm" type="submit" disabled={isLoadingDetails || isSavingDraft}>
                {isSavingDraft ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                保存配置
              </button>
            </div>
          </div>

          {editError && <div className="provider-edit-error">{editError}</div>}

          {isLoadingDetails ? (
            <div className="provider-editor-loading">
              <Loader2 className="spin" size={16} />
              正在读取原始配置...
            </div>
          ) : (
            <>
              <div className="provider-editor-grid">
                <label>
                  <span>名称</span>
                  <input value={editDraft.name} onChange={(event) => updateDraft("name", event.target.value)} />
                </label>
                <label>
                  <span>Base URL</span>
                  <input value={editDraft.baseUrl} onChange={(event) => updateDraft("baseUrl", event.target.value)} placeholder="https://example.com/v1" />
                </label>
                <label>
                  <span>上游代理（端口或 URL）</span>
                  <input value={editDraft.proxyUrl} onChange={(event) => updateDraft("proxyUrl", event.target.value)} placeholder="7890 或 http://127.0.0.1:7890" />
                </label>
                <label>
                  <span>认证方式</span>
                  <select value={editDraft.authMode} onChange={(event) => updateDraft("authMode", event.target.value)}>
                    <option value="api_key">API Key</option>
                    <option value="oauth_file">动态 OAuth 认证文件</option>
                    <option value="client_session">客户端会话（旧兼容）</option>
                  </select>
                </label>
                {editDraft.authMode === "api_key" && (
                  <label>
                    <span>API Key</span>
                    <div className="api-key-input">
                      <input
                        type="text"
                        value={isEditKeyVisible ? editDraft.apiKey : maskSecret(editDraft.apiKey)}
                        readOnly={!isEditKeyVisible}
                        onChange={(event) => updateDraft("apiKey", event.target.value)}
                        placeholder="sk-..."
                      />
                      <button type="button" title={isEditKeyVisible ? "隐藏 API Key" : "显示 API Key"} onClick={() => setIsEditKeyVisible((value) => !value)}>
                        {isEditKeyVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </label>
                )}
                <label>
                  <span>优先级</span>
                  <input type="number" min="1" value={editDraft.sortIndex} onChange={(event) => updateDraft("sortIndex", event.target.value)} />
                </label>
              </div>

              {editDraft.authMode === "oauth_file" && (
                <OAuthFileSourceFields
                  value={editDraft.oauthFilePath}
                  onChange={(value) => updateDraft("oauthFilePath", value)}
                  onDiscover={onDiscoverOAuthFiles}
                  disabled={isSavingDraft}
                />
              )}
              {editDraft.authMode === "client_session" && (
                <p className="auth-mode-hint">客户端会话模式需要调用方携带 OAuth 头，不适合当前 CCT 日常路径。</p>
              )}

              <div className="provider-editor-switches">
                <label>
                  <input type="checkbox" checked={editDraft.routingEnabled} onChange={(event) => updateDraft("routingEnabled", event.target.checked)} />
                  全局自动路由
                </label>
                <span>熔断失败 / 请求：{circuit.consecutiveFailures || 0} / {circuit.totalRequests || 0}</span>
                <span>计费请求：{billingStats?.requests || 0}</span>
              </div>

              <label className="provider-editor-field">
                <span>备注</span>
                <textarea rows="2" value={editDraft.notes} onChange={(event) => updateDraft("notes", event.target.value)} />
              </label>

              <div className="provider-editor-grid advanced">
                <label>
                  <span>首选测试模型</span>
                  <input
                    value={editDraft.preferredTestModel}
                    onChange={(event) => updateDraft("preferredTestModel", event.target.value)}
                    placeholder="例如：gpt-5.6-sol"
                  />
                </label>
                <label>
                  <span>临时支持模型（6 小时）</span>
                  <textarea
                    rows="3"
                    value={editDraft.supportedModelsText}
                    onChange={(event) => updateDraft("supportedModelsText", event.target.value)}
                    placeholder="每行或逗号分隔"
                  />
                </label>
                <label>
                  <span>临时不支持模型（30 分钟）</span>
                  <textarea
                    rows="3"
                    value={editDraft.unsupportedModelsText}
                    onChange={(event) => updateDraft("unsupportedModelsText", event.target.value)}
                    placeholder="每行或逗号分隔"
                  />
                </label>
              </div>

              <div className="provider-editor-grid advanced">
                <label>
                  <span>模型映射 JSON</span>
                  <textarea rows="6" value={editDraft.modelMapText} onChange={(event) => updateDraft("modelMapText", event.target.value)} placeholder={'{\n  "gpt-5.5": "real-upstream-model"\n}'} />
                </label>
                <label>
                  <span>自定义请求头 JSON</span>
                  <textarea rows="6" value={editDraft.customHeadersText} onChange={(event) => updateDraft("customHeadersText", event.target.value)} placeholder={'{\n  "x-provider": "value"\n}'} />
                </label>
              </div>

              <label className="provider-editor-field">
                <span>剥离参数</span>
                <textarea rows="3" value={editDraft.stripParamsText} onChange={(event) => updateDraft("stripParamsText", event.target.value)} placeholder={"parallel_tool_calls\nstore"} />
              </label>
            </>
          )}
        </form>
      )}
    </article>
  );

  async function toggleEditor() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    setEditError("");
    setIsLoadingDetails(Boolean(onLoadDetails));
    try {
      const details = onLoadDetails ? await onLoadDetails(provider) : provider;
      setEditDraft(providerToDraft(details));
      setIsEditKeyVisible(false);
    } catch (error) {
      setEditError(`读取原始配置失败: ${error.message}`);
      setEditDraft(providerToDraft(provider));
    } finally {
      setIsLoadingDetails(false);
    }
  }

  async function toggleSummaryKey() {
    if (isSummaryKeyVisible) {
      setIsSummaryKeyVisible(false);
      return;
    }
    try {
      const details = onLoadDetails ? await onLoadDetails(provider) : provider;
      setSummaryApiKey(details.apiKey || "");
      setIsSummaryKeyVisible(true);
    } catch (error) {
      setEditError(`读取 API Key 失败: ${error.message}`);
    }
  }

  function updateDraft(key, value) {
    setEditDraft((draft) => ({ ...draft, [key]: value }));
  }

  async function saveDraft(event) {
    event.preventDefault();
    setEditError("");
    let modelMap;
    let customHeaders;
    const supportedModels = parseList(editDraft.supportedModelsText);
    const unsupportedModels = parseList(editDraft.unsupportedModelsText);
    const conflictingModel = supportedModels.find((model) => unsupportedModels.includes(model));
    if (conflictingModel) {
      setEditError(`模型 ${conflictingModel} 不能同时标记为支持和不支持`);
      return;
    }
    try {
      modelMap = parseJsonObject(editDraft.modelMapText, "模型映射 JSON");
      customHeaders = parseJsonObject(editDraft.customHeadersText, "自定义请求头 JSON");
    } catch (error) {
      setEditError(error.message);
      return;
    }
    setIsSavingDraft(true);
    try {
      const ok = await onUpdate(provider, {
        name: editDraft.name,
        baseUrl: editDraft.baseUrl,
        proxyUrl: editDraft.proxyUrl,
        apiKey: editDraft.apiKey,
        authMode: editDraft.authMode,
        oauthFilePath: editDraft.oauthFilePath,
        routingEnabled: editDraft.routingEnabled,
        sortIndex: Number(editDraft.sortIndex || 1),
        notes: editDraft.notes,
        modelMap,
        modelSupport: {
          preferredTestModel: editDraft.preferredTestModel.trim(),
          supportedModels,
          unsupportedModels,
        },
        customHeaders,
        stripParams: parseList(editDraft.stripParamsText),
      });
      if (ok !== false) {
        setExpanded(false);
      }
    } finally {
      setIsSavingDraft(false);
    }
  }

  function duplicateProvider(source) {
    const text = `${source.name}\n${source.baseUrl}\n${source.notes || ""}`;
    navigator.clipboard?.writeText(text).catch(() => {});
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function providerToDraft(source) {
  return {
    name: source?.name || "",
    baseUrl: source?.baseUrl || "",
    proxyUrl: source?.proxyUrl || "",
    apiKey: source?.apiKey || "",
    authMode: source?.authMode || "api_key",
    oauthFilePath: source?.oauthFilePath || "",
    routingEnabled: Boolean(
      source?.routingEnabled ??
      (Boolean(source?.enabled ?? true) && Boolean(source?.inFailoverQueue ?? true)),
    ),
    sortIndex: source?.sortIndex || 1,
    notes: source?.notes || "",
    preferredTestModel: source?.modelSupport?.preferredTestModel || "",
    supportedModelsText: Array.isArray(source?.modelSupport?.supportedModels)
      ? source.modelSupport.supportedModels.join("\n")
      : "",
    unsupportedModelsText: Array.isArray(source?.modelSupport?.unsupportedModels)
      ? source.modelSupport.unsupportedModels.join("\n")
      : "",
    modelMapText: JSON.stringify(source?.modelMap || {}, null, 2),
    customHeadersText: JSON.stringify(source?.customHeaders || {}, null, 2),
    stripParamsText: Array.isArray(source?.stripParams) ? source.stripParams.join("\n") : "",
  };
}

function ModelSupportSummary({ support }) {
  const supported = support?.supportedModels || [];
  const unsupported = support?.unsupportedModels || [];
  const preferred = support?.preferredTestModel || "";
  if (!supported.length && !unsupported.length && !preferred) return null;
  return (
    <div className="provider-model-support">
      {preferred && <span>检测模型：{preferred}</span>}
      {supported.length > 0 && <span>支持：{supported.join("、")}</span>}
      {unsupported.length > 0 && <span>不支持：{unsupported.join("、")}</span>}
    </div>
  );
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function parseJsonObject(value, label) {
  const text = String(value || "").trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} 不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是对象`);
  }
  return parsed;
}

function parseList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
