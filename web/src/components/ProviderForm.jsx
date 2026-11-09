/**
 * 添加供应商表单组件。
 * 统一两处供应商创建入口，并避免 API Key 被浏览器误判为登录密码。
 */

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { OAuthFileSourceFields } from "./OAuthFileSourceFields.jsx";

export function ProviderForm({
  draft,
  onDraftChange,
  onSubmit,
  saving,
  onDiscoverOAuthFiles,
}) {
  function update(key, value) {
    onDraftChange({ ...draft, [key]: value });
  }

  return (
    <form className="provider-form" autoComplete="off" onSubmit={onSubmit}>
      <TextField label="名称" value={draft.name} onChange={(value) => update("name", value)} placeholder="例如：中转站 A" required />
      <TextField label="Base URL" value={draft.baseUrl} onChange={(value) => update("baseUrl", value)} placeholder="https://example.com/v1" required />
      <TextField label="上游代理（端口或 URL）" value={draft.proxyUrl} onChange={(value) => update("proxyUrl", value)} placeholder="7890 或 http://127.0.0.1:7890" />
      <AuthModeField value={draft.authMode} onChange={(value) => update("authMode", value)} />
      {draft.authMode === "api_key" && <ApiKeyField value={draft.apiKey} onChange={(value) => update("apiKey", value)} required />}
      {draft.authMode === "oauth_file" && (
        <OAuthFileSourceFields
          value={draft.oauthFilePath}
          onChange={(value) => update("oauthFilePath", value)}
          onDiscover={onDiscoverOAuthFiles}
          disabled={saving}
        />
      )}
      {draft.authMode === "client_session" && (
        <p className="auth-mode-hint">客户端会话模式仅用于兼容已有配置，日常 CCT 不建议使用。</p>
      )}
      <NumberField label="优先级" value={draft.sortIndex} onChange={(value) => update("sortIndex", value)} />
      <TextField label="备注" value={draft.notes} onChange={(value) => update("notes", value)} placeholder="额度、来源或说明" />
      <button className="button" type="submit" disabled={saving}>添加到队列</button>
    </form>
  );
}

// 通用表单字段包装器，供设置页和供应商表单共用。
export function Field({ label, children }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function TextField({ label, value, onChange, placeholder, required }) {
  return (
    <Field label={label}>
      <input type="text" value={value} placeholder={placeholder} required={required} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function AuthModeField({ value, onChange }) {
  return (
    <Field label="认证方式">
      <select value={value || "api_key"} onChange={(event) => onChange(event.target.value)}>
        <option value="api_key">API Key</option>
        <option value="oauth_file">动态 OAuth 认证文件</option>
        <option value="client_session" disabled>客户端会话（仅兼容已有配置）</option>
      </select>
    </Field>
  );
}

function ApiKeyField({ value, onChange, required = false }) {
  const [isVisible, setIsVisible] = useState(false);
  return (
    <Field label="API Key">
      <div className="api-key-input provider-api-key-input">
        <input
          className={isVisible ? "" : "api-key-masked"}
          type="text"
          value={value}
          placeholder="sk-..."
          required={required}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck="false"
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          title={isVisible ? "隐藏 API Key" : "显示 API Key"}
          aria-label={isVisible ? "隐藏 API Key" : "显示 API Key"}
          onClick={() => setIsVisible((current) => !current)}
        >
          {isVisible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </Field>
  );
}

// 通用数字输入字段，统一设置页的数值输入行为。
export function NumberField({ label, value, onChange }) {
  return (
    <Field label={label}>
      <input type="number" value={value ?? 0} step="1" onChange={(event) => onChange(Number(event.target.value))} />
    </Field>
  );
}
