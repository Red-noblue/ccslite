/**
 * OAuth 认证文件选择组件。
 *
 * 浏览器不能安全地把宿主机文件路径直接交给服务端，因此这里仅展示服务端发现的
 * 候选文件并保存路径；不会上传、复制或展示 OAuth 文件内容。
 */

import { useEffect, useState } from "react";
import { CheckCircle2, FolderSearch, Loader2, RefreshCw, XCircle } from "lucide-react";

export function OAuthFileSourceFields({
  value,
  onChange,
  onDiscover,
  disabled = false,
}) {
  const [discovery, setDiscovery] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadCandidates();
  }, [onDiscover]);

  async function loadCandidates() {
    if (!onDiscover) return;
    setLoading(true);
    setError("");
    try {
      setDiscovery(await onDiscover());
    } catch (loadError) {
      setError(loadError?.message || "无法识别本机认证文件");
    } finally {
      setLoading(false);
    }
  }

  const candidates = discovery?.candidates || [];
  return (
    <div className="oauth-file-source">
      <div className="oauth-file-source-head">
        <div>
          <strong>动态 OAuth 认证文件</strong>
          <p>Lite 仅保存路径；每次请求即时读取当前会话，不复制令牌。</p>
        </div>
        <button
          className="cc-button cc-button-secondary cc-button-sm"
          type="button"
          onClick={loadCandidates}
          disabled={disabled || loading}
          title="重新识别本机 Codex 与 CC Switch 认证文件"
        >
          {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          重新识别
        </button>
      </div>

      <div className={`oauth-file-source-detection ${discovery?.ccSwitchDetected ? "ok" : ""}`}>
        <FolderSearch size={15} />
        <span>{discovery?.ccSwitchDetected ? "已识别到本机 CC Switch" : "正在识别本机 CC Switch"}</span>
      </div>

      {error && <p className="oauth-file-source-error">{error}</p>}

      <div className="oauth-file-candidates">
        {candidates.map((candidate) => {
          const ready = candidate.status === "ready";
          const selected = value === candidate.path;
          return (
            <div className={`oauth-file-candidate ${ready ? "ready" : "unavailable"}`} key={candidate.path}>
              <div>
                <strong>{candidate.label}</strong>
                <code title={candidate.path}>{candidate.path}</code>
                <small>{candidate.detail}</small>
              </div>
              <button
                className="cc-button cc-button-secondary cc-button-sm"
                type="button"
                disabled={disabled || !ready}
                onClick={() => onChange(candidate.path)}
              >
                {selected ? <CheckCircle2 size={14} /> : ready ? <FolderSearch size={14} /> : <XCircle size={14} />}
                {selected ? "已选用" : ready ? "使用此文件" : "不可用"}
              </button>
            </div>
          );
        })}
      </div>

      <label className="oauth-file-manual-path">
        <span>手动指定认证文件路径</span>
        <input
          type="text"
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder="/Users/你的用户名/.codex/auth.json"
          disabled={disabled}
          autoComplete="off"
          spellCheck="false"
        />
      </label>
      <p className="oauth-file-source-hint">仅接受当前用户目录内名为 <code>auth.json</code> 的文件；文件内容不会发送到管理台。</p>
    </div>
  );
}
