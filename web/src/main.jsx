/**
 * Lite CC Switch React 管理台主入口。
 * 采用 ccswitch 的 React/Vite 前端体系，改为通过服务器 HTTP API 管理本机代理。
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Clock3,
  GitBranch,
  Info,
  Loader2,
  Lock,
  MemoryStick,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shield,
  Unlock,
  X,
} from "lucide-react";
import { ProviderCard } from "./components/ProviderCard.jsx";
import { Field, NumberField, ProviderForm } from "./components/ProviderForm.jsx";
import { UsageDashboard } from "./components/UsageDashboard.jsx";
import { formatNumber } from "./components/format.js";
import { mergeStatus } from "./status-state.js";
import { providersForGroupView } from "./provider-view.js";
import { UI_PALETTE_PRESETS, hexToRgba, paletteForGroup } from "../../lib/ui-theme.js";
import "./styles.css";

const initialProviderForm = {
  name: "",
  baseUrl: "",
  proxyUrl: "",
  apiKey: "",
  authMode: "api_key",
  oauthFilePath: "",
  sortIndex: 1,
  notes: "",
};

const CONNECTIVITY_INTERVAL_OPTIONS = [
  { value: 30 * 60_000, label: "0.5h" },
  { value: 60 * 60_000, label: "1h" },
  { value: 2 * 60 * 60_000, label: "2h" },
  { value: 3 * 60 * 60_000, label: "3h" },
  { value: 6 * 60 * 60_000, label: "6h" },
  { value: 12 * 60 * 60_000, label: "12h" },
  { value: 24 * 60 * 60_000, label: "24h" },
  { value: 3 * 24 * 60 * 60_000, label: "3d" },
  { value: 7 * 24 * 60 * 60_000, label: "7d" },
  { value: 14 * 24 * 60 * 60_000, label: "14d" },
  { value: 30 * 24 * 60 * 60_000, label: "1个月" },
  { value: "never", label: "永不" },
];

const SETTINGS_SECTIONS = [
  ["settings-current-group", "当前分组"],
  ["settings-runtime", "运行与持久化"],
  ["settings-theme", "界面配色"],
  ["settings-proxy", "代理策略"],
  ["settings-connectivity", "连通性测试"],
  ["settings-groups", "分组管理"],
  ["settings-provider", "添加供应商"],
];

const THEME_CACHE_KEY = "lite-ccswitch-last-theme";
const USAGE_SECTIONS = ["stats", "experiment", "calibration"];
const SETTINGS_HOME = SETTINGS_SECTIONS[0][0];

// 页面、分组和可直达的子页统一从地址恢复，分组使用稳定 ID。
function readRoute(hash) {
  const [page, query] = hash.slice(1).split("?", 2);
  const params = new URLSearchParams(query);
  const view = ["settings", "billing", "add"].includes(page) ? page : "providers";
  const section = params.get("section");
  return {
    view,
    groupId: params.get("group") || "default",
    section: view === "settings" ? SETTINGS_SECTIONS.find(([id]) => id === section)?.[0] || SETTINGS_HOME
      : view === "billing" ? USAGE_SECTIONS.find((id) => id === section) || "stats" : null,
    providerId: view === "billing" ? params.get("provider") : null,
  };
}

function routeHash({ view, groupId, section, providerId }) {
  const params = new URLSearchParams();
  if (groupId !== "default") params.set("group", groupId);
  if (view === "settings" && section && section !== SETTINGS_HOME) params.set("section", section);
  if (view === "billing") {
    if (section && section !== "stats") params.set("section", section);
    if (providerId) params.set("provider", providerId);
  }
  const query = params.toString();
  return `#${view}${query ? `?${query}` : ""}`;
}

function groupListenerLabel(group) {
  return group?.actualListener
    ? `监听 ${group.actualListener.host}:${group.actualListener.port}`
    : `${group?.listenerStatus === "error" ? "监听失败" : group?.listener?.enabled === false ? "已停用" : "未监听"}${group?.listener?.port ? `（配置 ${group.listener.port}）` : ""}`;
}

function applyPaletteVariables(palette) {
  const root = document.documentElement;
  root.style.setProperty("--primary", palette.primary);
  root.style.setProperty("--primary-hover", palette.hover);
  root.style.setProperty("--primary-soft", palette.soft);
  root.style.setProperty("--border-hover", hexToRgba(palette.accent, 0.38));
  root.style.setProperty("--theme-primary-gradient-end", palette.hover);
  root.style.setProperty("--theme-sidebar-start", palette.start);
  root.style.setProperty("--theme-sidebar-end", palette.end);
  root.style.setProperty("--theme-primary-shadow", palette.shadow);
}

function bootstrapCachedTheme() {
  try {
    const cached = JSON.parse(window.localStorage.getItem(THEME_CACHE_KEY) || "null");
    if (!cached?.primary) return;
    // 首次绘制前恢复上次分组的完整配色，避免刷新时先闪现默认蓝色。
    applyPaletteVariables(cached);
  } catch {
    // 本地缓存损坏时使用 CSS 默认主题，不影响页面加载。
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") bootstrapCachedTheme();

function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const route = useMemo(() => readRoute(hash), [hash]);
  const { view: activeView, groupId: selectedGroupId } = route;
  const [status, setStatus] = useState(null);
  const [billing, setBilling] = useState(null);
  const [pricing, setPricing] = useState([{ model: "*", inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheCreationPerMillion: 0 }]);
  const [proxyDraft, setProxyDraft] = useState(null);
  const [uiThemeDraft, setUiThemeDraft] = useState(null);
  const [connectivityDraft, setConnectivityDraft] = useState(null);
  const [candidateModelsDraft, setCandidateModelsDraft] = useState(null);
  const [providerForm, setProviderForm] = useState(initialProviderForm);
  const [providerSearch, setProviderSearch] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupSearchOpen, setGroupSearchOpen] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] = useState(SETTINGS_HOME);
  const [settingsFlashSection, setSettingsFlashSection] = useState(null);
  const settingsScrollLockRef = useRef(null);
  const [providerTestResults, setProviderTestResults] = useState({});
  const [events, setEvents] = useState(["等待状态..."]);
  const [notifications, setNotifications] = useState([]);
  const notificationId = useRef(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connectivitySaving, setConnectivitySaving] = useState(false);
  const [diagnostics413, setDiagnostics413] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [groupSettingsDraft, setGroupSettingsDraft] = useState(null);
  const [groupSettingsSaving, setGroupSettingsSaving] = useState(false);
  const [groupCreateDraft, setGroupCreateDraft] = useState({ name: "", description: "", port: "" });
  const [groupCreating, setGroupCreating] = useState(false);
  const selectedGroupRef = useRef(selectedGroupId);
  selectedGroupRef.current = selectedGroupId;
  const viewScrollPositions = useRef(new Map());
  const activeViewRef = useRef(activeView); activeViewRef.current = activeView;
  const statusRef = useRef(status); statusRef.current = status;
  const statusStreamReady = useRef(false);
  const refreshController = useRef(null);
  const groupReady = selectedGroupId === "default" || Boolean(status?.groups?.some((group) => group.id === selectedGroupId));

  useEffect(() => {
    const readLocation = () => setHash(window.location.hash);
    window.addEventListener("popstate", readLocation);
    window.addEventListener("hashchange", readLocation);
    return () => {
      window.removeEventListener("popstate", readLocation);
      window.removeEventListener("hashchange", readLocation);
    };
  }, []);

  function navigate(view, groupId = selectedGroupId, { section, providerId } = {}) {
    const next = routeHash({ view, groupId, section, providerId });
    if (window.location.hash !== next) window.history.pushState(null, "", next);
    setHash(next);
  }

  function applyStatus(nextStatus) {
    setStatus((current) => mergeStatus(current, nextStatus));
  }

  const discoverOAuthFiles = useCallback(
    () => api("/api/oauth-files/discover"),
    [],
  );

  async function refresh(silent = false) {
    const requestGroupId = selectedGroupId;
    refreshController.current?.abort();
    const controller = new AbortController(); refreshController.current = controller;
    const read = (path) => api(path, { signal: controller.signal });
    try {
      if (!silent) setLoading(true);
      const [nextStatus, nextBilling, nextDiagnostics413] = await Promise.all([
        !silent || !statusStreamReady.current || !statusRef.current ? read("/api/status") : null,
        activeViewRef.current === "providers" && groupReady ? read(`/api/billing/summary?timezoneOffset=${new Date().getTimezoneOffset()}&groupId=${encodeURIComponent(requestGroupId)}`) : null,
        activeViewRef.current === "settings" ? read("/api/diagnostics/413") : null,
      ]);
      if (controller.signal.aborted || selectedGroupRef.current !== requestGroupId) return;
      if (nextStatus) applyStatus(nextStatus);
      const effectiveStatus = nextStatus || statusRef.current;
      if (nextBilling) setBilling(nextBilling.groupId === requestGroupId || (requestGroupId === "default" && !nextBilling.groupId)
        ? { ...nextBilling, scopeGroupId: requestGroupId } : null);
      if (nextDiagnostics413) setDiagnostics413(nextDiagnostics413);
      setProxyDraft((current) => current || cloneProxy(effectiveStatus.proxy));
      setUiThemeDraft((current) => current || {
        palette: effectiveStatus.ui?.palette || "ocean",
        groupThemeEnabled: effectiveStatus.ui?.groupThemeEnabled !== false,
      });
      setConnectivityDraft((current) => current || cloneConnectivityTest(effectiveStatus.connectivityTest));
      setCandidateModelsDraft((current) => current ?? (effectiveStatus.connectivityTest?.candidateModels || []).join(", "));
      setPricing((current) => current.length && current.some((row) => row.model) ? current : pricingToRows(nextBilling?.pricing?.pricing || {}));
      if (!silent) pushEvent("状态已刷新");
    } catch (error) {
      if (error.name !== "AbortError") pushEvent(`刷新失败: ${error.message}`, "error", !silent);
    } finally {
      if (refreshController.current === controller) setLoading(false);
    }
  }

  useEffect(() => {
    setProxyDraft(null);
  }, [selectedGroupId]);

  useEffect(() => {
    refresh(true);
    const tick = () => { if (!document.hidden) refresh(true); };
    const timer = setInterval(tick, 5000);
    const visible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); refreshController.current?.abort(); document.removeEventListener("visibilitychange", visible); };
  }, [selectedGroupId, activeView, groupReady]);

  useEffect(() => {
    const stream = new EventSource("/api/status/events");
    stream.onopen = () => { statusStreamReady.current = true; };
    stream.onerror = () => { statusStreamReady.current = false; };
    const handleStatus = (event) => {
      try { applyStatus(JSON.parse(event.data)); }
      catch { statusStreamReady.current = false; }
    };
    stream.addEventListener("status", handleStatus);
    return () => { statusStreamReady.current = false; stream.removeEventListener("status", handleStatus); stream.close(); };
  }, []);

  const sharedProviders = useMemo(
    () => status?.providers || [],
    [status],
  );
  const groups = useMemo(() => (status?.groups || []).map((group) => group.id === "default" ? {
    ...group,
    listener: { ...group.listener, host: status.address, port: status.port },
    actualListener: { host: status.address, port: status.port },
  } : group), [status]);
  const filteredGroups = useMemo(() => {
    const keyword = groupSearch.trim().toLowerCase();
    if (!keyword) return groups;
    return groups.filter((group) => [group.name, group.description, group.listener?.port].join(" ").toLowerCase().includes(keyword));
  }, [groups, groupSearch]);
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || groups[0] || null,
    [groups, selectedGroupId],
  );
  const providers = useMemo(() => {
    return providersForGroupView(sharedProviders, selectedGroup);
  }, [sharedProviders, selectedGroup]);
  const usageProviderFilter = route.providerId ? providers.find((provider) => provider.id === route.providerId) || null : null;
  const groupIsolationReady = Boolean(selectedGroup?.statistics);
  const groupRoutingReady = Boolean(selectedGroup?.proxy);
  const groupApi = useCallback(async (url, options) => {
    if (selectedGroupId !== "default" && !groupRoutingReady && options?.method && options.method !== "GET") {
      throw new Error("分组独立路由需要重启主服务后启用");
    }
    if (selectedGroupId !== "default" && !groupIsolationReady && (url.startsWith("/api/price-lab") || url.endsWith("/test"))) {
      throw new Error("本分组的检测和实验隔离需要重启主服务后启用");
    }
    return api(`${url}${url.includes("?") ? "&" : "?"}groupId=${encodeURIComponent(selectedGroupId)}`, options);
  }, [selectedGroupId, groupIsolationReady, groupRoutingReady]);
  const groupStatistics = selectedGroup?.statistics || (selectedGroup?.id === "default" ? status : null);
  const streamDiagnostics = groupStatistics?.streamDiagnostics || null;
  const groupActivity = selectedGroup?.providerActivity || (status?.providerActivity ? {
    ...status.providerActivity,
    providers: status.providerActivity.providers.filter((provider) => (provider.groupId || "default") === selectedGroup?.id),
  } : selectedGroup?.id && selectedGroup.id !== "default" ? { windowMs: 5000, providers: [] } : null);
  const groupActiveRequests = selectedGroup?.activeRequests?.requests || (selectedGroup?.id === "default" ? status?.activeRequests?.requests || [] : []);
  const groupBilling = billing?.scopeGroupId === selectedGroup?.id ? billing : null;
  const selectedGroupProviderIds = useMemo(
    () => new Set(providers.filter((provider) => provider.routingEnabled).map((provider) => provider.id)),
    [providers],
  );

  useEffect(() => {
    const next = routeHash({
      ...route,
      groupId: groups.length && !groupReady ? "default" : selectedGroupId,
      providerId: Array.isArray(status?.providers) && !usageProviderFilter ? null : route.providerId,
    });
    if (hash === window.location.hash && hash !== next) {
      window.history.replaceState(null, "", next);
      setHash(next);
    }
  }, [hash, route, groups.length, groupReady, selectedGroupId, status?.providers, usageProviderFilter]);

  useEffect(() => {
    if (!selectedGroup) return;
    setGroupSettingsDraft({
      name: selectedGroup.name,
      description: selectedGroup.description || "",
      port: selectedGroup.listener?.port || "",
      listenerEnabled: selectedGroup.listener?.enabled !== false,
      palette: selectedGroup.theme?.palette || "auto",
      accent: paletteForGroup(selectedGroup, groups.indexOf(selectedGroup), status?.ui?.palette || "ocean").accent,
      accentMode: selectedGroup.theme?.accentMode || (selectedGroup.theme?.palette === "custom" ? "custom" : "auto"),
      accentLocked: selectedGroup.theme?.accentLocked === true,
    });
  }, [selectedGroup?.id, status?.ui?.palette]);

  useEffect(() => {
    if (!status) return undefined;
    const root = document.documentElement;
    const palette = paletteForGroup(
      status.ui?.groupThemeEnabled === false ? null : selectedGroup,
      status.ui?.groupThemeEnabled === false ? 0 : groups.indexOf(selectedGroup),
      status.ui?.palette || "ocean",
    );
    applyPaletteVariables(palette);
    try {
      window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(palette));
    } catch {
      // 浏览器禁用本地存储时仍使用当前会话主题。
    }
    return () => {
      if (document.documentElement !== root) return;
      root.style.removeProperty("--primary");
      root.style.removeProperty("--primary-hover");
      root.style.removeProperty("--primary-soft");
      root.style.removeProperty("--border-hover");
      root.style.removeProperty("--theme-primary-gradient-end");
      root.style.removeProperty("--theme-sidebar-start");
      root.style.removeProperty("--theme-sidebar-end");
      root.style.removeProperty("--theme-primary-shadow");
    };
  }, [selectedGroup, status?.ui?.palette, status?.ui?.groupThemeEnabled]);
  const filteredProviders = useMemo(() => {
    const keyword = providerSearch.trim().toLowerCase();
    if (!keyword) return providers;
    return providers.filter((provider) => {
      const haystack = [
        provider.name,
        provider.baseUrl,
        provider.notes,
        provider.apiKeyMasked,
      ].join(" ").toLowerCase();
      return haystack.includes(keyword);
    });
  }, [providers, providerSearch]);
  const providerBillingByName = useMemo(() => {
    const map = new Map();
    for (const item of groupBilling?.today?.business?.providers || []) {
      map.set(item.name, item);
    }
    return map;
  }, [groupBilling]);

  function notify(message, tone = "info") {
    const id = ++notificationId.current;
    setNotifications((items) => [...items, { id, message, tone }].slice(-4));
  }

  const dismissNotification = useCallback((id) => {
    setNotifications((items) => items.filter((item) => item.id !== id));
  }, []);

  function pushEvent(message, requestedTone, showToast = true) {
    const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`;
    setEvents((items) => [line, ...items.filter((item) => item !== "等待状态...")].slice(0, 80));
    if (showToast && message !== "状态已刷新") {
      const tone = requestedTone || (/失败|错误|未通过/.test(message) ? "error" : /已添加|已更新|已删除|完成|已保存|已复制|已新建|已取消/.test(message) ? "success" : "info");
      notify(message, tone);
    }
  }

  async function saveProxy() {
    if (!proxyDraft) return;
    setSaving(true);
    try {
      await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ proxy: normalizeProxyDraft(proxyDraft) }),
      });
      setProxyDraft(null);
      await refresh(true);
      pushEvent("代理策略已保存");
    } catch (error) {
      pushEvent(`保存代理策略失败: ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveUiTheme() {
    if (!uiThemeDraft) return;
    setSaving(true);
    try {
      await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ ui: uiThemeDraft }),
      });
      setUiThemeDraft(null);
      await refresh(true);
      pushEvent("界面配色策略已保存");
    } catch (error) {
      pushEvent(`保存界面配色策略失败: ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  // 写入后读取服务端状态，独立于按时轮询，避免请求被定时刷新取消。
  async function refreshProviderStatus() {
    try { applyStatus(await api("/api/status")); }
    catch (error) { pushEvent(`配置已提交，读取最新列表失败：${error.message}`, "error"); }
  }

  async function addProvider(event) {
    event.preventDefault();
    setSaving(true);
    try {
      await groupApi("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          ...providerForm,
          sortIndex: Number(providerForm.sortIndex || 1),
          routingEnabled: true,
        }),
      });
      setProviderForm(initialProviderForm);
      await refreshProviderStatus();
      pushEvent(`已添加供应商: ${providerForm.name}`);
    } catch (error) {
      pushEvent(`添加供应商失败: ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function updateProvider(provider, patch) {
    try {
      await groupApi(`/api/providers/${encodeURIComponent(provider.id)}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      await refreshProviderStatus();
      pushEvent(`供应商已更新: ${provider.name}`);
      return true;
    } catch (error) {
      pushEvent(`供应商更新失败: ${error.message}`);
      return false;
    }
  }

  async function saveGroupSettings(event) {
    event.preventDefault();
    if (!selectedGroup || !groupSettingsDraft || groupSettingsSaving) return;
    setGroupSettingsSaving(true);
    try {
      await api(`/api/groups/${encodeURIComponent(selectedGroup.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: groupSettingsDraft.name,
          description: groupSettingsDraft.description,
          ...(selectedGroup.id === "default" ? {} : { listener: { port: Number(groupSettingsDraft.port || 0), enabled: groupSettingsDraft.listenerEnabled } }),
          theme: {
            accentMode: groupSettingsDraft.accentMode,
            accent: groupSettingsDraft.accent,
            accentLocked: groupSettingsDraft.accentLocked,
          },
        }),
      });
      await refresh(true);
      pushEvent(`分组设置已保存：${groupSettingsDraft.name}`);
    } catch (error) {
      pushEvent(`保存分组设置失败: ${error.message}`);
    } finally {
      setGroupSettingsSaving(false);
    }
  }

  async function createGroupFromSettings({ clone = false } = {}) {
    if (groupCreating) return;
    if (!clone && !groupCreateDraft.name.trim()) {
      pushEvent("新建分组需要填写名称");
      return;
    }
    setGroupCreating(true);
    try {
      const created = await api("/api/groups", {
        method: "POST",
        body: JSON.stringify(clone
          ? { sourceGroupId: selectedGroup?.id, name: groupCreateDraft.name.trim() || undefined }
          : {
            name: groupCreateDraft.name.trim(),
            description: groupCreateDraft.description.trim(),
            listener: { port: Number(groupCreateDraft.port || 0) },
            providerRefs: [],
          }),
      });
      setGroupCreateDraft({ name: "", description: "", port: "" });
      await refreshProviderStatus();
      navigate("providers", created.id);
      pushEvent(`${clone ? "已复制分组" : "已新建分组"}：${created.name}`);
    } catch (error) {
      pushEvent(`${clone ? "复制" : "新建"}分组失败: ${error.message}`);
    } finally {
      setGroupCreating(false);
    }
  }

  async function loadProviderDetails(provider) {
    return groupApi(`/api/providers/${encodeURIComponent(provider.id)}`);
  }

  async function providerAction(provider, action) {
    const testKey = `${selectedGroupId}:${provider.id}`;
    if (action === "delete" && !window.confirm(`确认从所有分组删除供应商 ${provider.name}？`)) return;
    if (action === "test") {
      const transport = ["oauth_file", "client_session"].includes(provider.authMode) ? "sse" : "json";
      const transportMessage = transport === "json"
        ? "连通性检测使用 JSON 非流式响应，与正常对话的 SSE 不同；请用编码兼容性检查单独验证流式协议。"
        : "连通性检测使用 SSE 流式响应。";
      setProviderTestResults((items) => ({
        ...items,
        [testKey]: {
          state: "pending",
          message: `正在等待模型回答。${transportMessage}`,
          transport,
          startedAt: new Date().toISOString(),
        },
      }));
      pushEvent(`开始检测: ${provider.name}。${transportMessage}`, "info");
    }
    try {
      const path = action === "delete"
        ? `/api/providers/${encodeURIComponent(provider.id)}`
        : `/api/providers/${encodeURIComponent(provider.id)}/${action}`;
      const result = await groupApi(path, { method: action === "delete" ? "DELETE" : "POST" });
      await refreshProviderStatus();
      if (action === "test") {
        const message = result.message || (result.ok ? "模型回答正常" : "检测失败");
        setProviderTestResults((items) => ({
          ...items,
          [testKey]: {
            state: result.ok ? "success" : "failed",
            ok: Boolean(result.ok),
            status: result.status,
            model: result.model,
            transport: result.transport || "unknown",
            answer: result.answer,
            message,
            latencyMs: result.latencyMs,
            attempts: result.attempts,
            routingEffect: result.routingEffect,
            routingMessage: result.routingMessage,
            updatedAt: new Date().toISOString(),
          },
        }));
        pushEvent(`测试完成: ${provider.name} ${result.ok ? "正常" : "失败"}，${message}${result.routingMessage ? `；${result.routingMessage}` : ""}；${result.transport === "json" ? "JSON 非流式" : result.transport === "sse" ? "SSE 流式" : "传输方式未知"}，延迟 ${result.latencyMs}ms`, result.ok ? "success" : "error");
      } else {
        pushEvent(action === "delete" ? `已删除供应商: ${provider.name}` : `供应商操作完成: ${provider.name}`, "success");
      }
    } catch (error) {
      if (action === "test") {
        setProviderTestResults((items) => ({
          ...items,
          [testKey]: {
            state: "failed",
            ok: false,
            message: error.message,
            updatedAt: new Date().toISOString(),
          },
        }));
      }
      pushEvent(`供应商操作失败: ${error.message}`);
    }
  }

  async function cancelActiveRequest(request) {
    try {
      await api(`/api/requests/${encodeURIComponent(request.id)}/cancel?groupId=${encodeURIComponent(selectedGroupId)}`, { method: "POST" });
      await refresh(true);
      pushEvent(`已取消活动请求：${request.requestId || request.id}`);
    } catch (error) {
      pushEvent(`取消活动请求失败: ${error.message}`);
    }
  }

  async function runConnectivityTest() {
    try {
      pushEvent("开始立即连通性测试...");
      const result = await groupApi("/api/connectivity/test", { method: "POST" });
      await refresh(true);
      const successCount = result.results?.filter((item) => item.ok).length || 0;
      const totalCount = result.results?.length || 0;
      pushEvent(`立即测试完成：${successCount}/${totalCount} 个供应商正常，结果已用于自动路由`);
    } catch (error) {
      pushEvent(`立即连通性测试失败: ${error.message}`);
    }
  }

  async function arm413Diagnostics() {
    try {
      const result = await api("/api/diagnostics/413/arm", { method: "POST" });
      setDiagnostics413(result);
      pushEvent("已等待下一次上游 413；诊断不会写入普通对话日志");
    } catch (error) {
      pushEvent(`启用 413 诊断失败: ${error.message}`);
    }
  }

  async function updateConnectivityInterval(periodicIntervalMs) {
    if (connectivitySaving) return;
    const nextConnectivityTest = { periodicIntervalMs };
    setConnectivityDraft(nextConnectivityTest);
    setConnectivitySaving(true);
    try {
      await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ connectivityTest: nextConnectivityTest }),
      });
      setConnectivityDraft(null);
      await refresh(true);
      pushEvent(`自动测试间隔已更新为 ${formatConnectivityInterval(periodicIntervalMs)}`);
    } catch (error) {
      setConnectivityDraft(null);
      await refresh(true);
      pushEvent(`更新自动测试间隔失败: ${error.message}`);
    } finally {
      setConnectivitySaving(false);
    }
  }

  async function updateConnectivityModels() {
    if (connectivitySaving) return;
    const candidateModels = uniqueModelNames(candidateModelsDraft);
    if (candidateModels.length === 0) {
      pushEvent("测试模型顺序不能为空");
      return;
    }
    setConnectivitySaving(true);
    try {
      await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ connectivityTest: { candidateModels } }),
      });
      setCandidateModelsDraft(candidateModels.join(", "));
      await refresh(true);
      pushEvent(`测试模型顺序已更新：${candidateModels.join(" → ")}`);
    } catch (error) {
      pushEvent(`更新测试模型顺序失败: ${error.message}`);
    } finally {
      setConnectivitySaving(false);
    }
  }

  async function savePricing() {
    const payload = {};
    for (const row of pricing) {
      const model = row.model.trim();
      if (!model) continue;
      payload[model] = {
        inputPerMillion: Number(row.inputPerMillion || 0),
        outputPerMillion: Number(row.outputPerMillion || 0),
        cacheReadPerMillion: Number(row.cacheReadPerMillion || 0),
        cacheCreationPerMillion: Number(row.cacheCreationPerMillion || 0),
      };
    }
    try {
      await api("/api/billing/pricing", {
        method: "PUT",
        body: JSON.stringify({ pricing: payload }),
      });
      await refresh(true);
      pushEvent("计费价格已保存");
    } catch (error) {
      pushEvent(`保存计费价格失败: ${error.message}`);
    }
  }

  function openUsageDashboard(provider, section = "stats") {
    navigate("billing", selectedGroupId, { section, providerId: provider?.id });
  }

  function scrollSettingsSection(sectionId) {
    const target = document.getElementById(sectionId);
    if (!target) return;
    const details = target.closest("details");
    if (details) details.open = true;
    setActiveSettingsSection(sectionId);
    settingsScrollLockRef.current = sectionId;
    window.setTimeout(() => {
      if (settingsScrollLockRef.current === sectionId) settingsScrollLockRef.current = null;
    }, 1400);
    setSettingsFlashSection(sectionId);
    window.setTimeout(() => setSettingsFlashSection((current) => current === sectionId ? null : current), 1100);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function settingsSectionClass(sectionId) {
    return `settings-anchor ${settingsFlashSection === sectionId ? "settings-anchor-flash" : ""}`;
  }

  const settingsReady = Boolean(selectedGroup) && (route.section !== "settings-connectivity" || Boolean(proxyDraft));
  useEffect(() => {
    if (activeView !== "settings" || !settingsReady) return undefined;
    const frame = window.requestAnimationFrame(() => scrollSettingsSection(route.section));
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, selectedGroupId, route.section, settingsReady]);

  useEffect(() => {
    if (activeView !== "settings") return undefined;
    const root = document.querySelector(".cc-view-scroll");
    const targets = SETTINGS_SECTIONS
      .map(([id]) => document.getElementById(id))
      .filter(Boolean);
    if (!root || !targets.length) return undefined;
    const updateActiveSection = () => {
      if (settingsScrollLockRef.current) return;
      const boundary = root.getBoundingClientRect().top + 86;
      const passed = targets.filter((target) => target.getBoundingClientRect().top <= boundary);
      setActiveSettingsSection((passed[passed.length - 1] || targets[0]).id);
    };
    root.addEventListener("scroll", updateActiveSection, { passive: true });
    return () => root.removeEventListener("scroll", updateActiveSection);
  }, [activeView, selectedGroupId, settingsReady]);

  return (
    <main className="cc-app">
      <header className="cc-header">
        <div className="header-left">
          <a className="brand-title" href={routeHash({ view: "providers", groupId: selectedGroupId })}>
            CC Switch
          </a>
          <button className="icon-button" title="设置与分组管理" onClick={() => navigate("settings")}>
            <Settings size={17} />
          </button>
          <button className="icon-button" title="使用统计" onClick={() => openUsageDashboard(null)}>
            <BarChart3 size={17} />
          </button>
        </div>

        <div key={activeView === "settings" ? "settings-nav" : "app-nav"} className={`header-center ${activeView === "settings" ? "header-settings-nav" : "header-app-nav"}`}>
          {activeView === "settings" ? SETTINGS_SECTIONS.map(([id, label]) => (
            <button
              className={activeSettingsSection === id ? "active" : ""}
              type="button"
              key={id}
              aria-current={activeSettingsSection === id ? "location" : undefined}
              onClick={() => {
                if (route.section === id) scrollSettingsSection(id);
                else navigate("settings", selectedGroupId, { section: id });
              }}
            >
              {label}
            </button>
          )) : (
            <>
              <button className="app-tab active">
                <span className="app-dot">AI</span>
                Codex
              </button>
              <button className="app-tab muted" disabled>Claude</button>
              <button className="app-tab muted" disabled>Gemini</button>
            </>
          )}
        </div>

        <div className="header-actions">
          <span className={`proxy-chip ${status?.running ? "ok" : "bad"}`}>
            <Server size={14} />
            {status?.running ? "本地代理运行中" : "代理检查中"}
          </span>
          <span className={`proxy-chip ${proxyDraft?.autoFailoverEnabled ? "ok" : ""}`}>
            <GitBranch size={14} />
            故障转移{proxyDraft?.autoFailoverEnabled ? "开启" : "关闭"}
          </span>
          <button className="button ghost" onClick={() => refresh()} disabled={loading}>
            {loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          </button>
          {status?.security?.adminTokenConfigured && <button className="button ghost" onClick={async () => {
            await api("/api/auth/logout", { method: "POST" });
            window.dispatchEvent(new Event("lite-auth-expired"));
          }}>退出登录</button>}
        </div>
      </header>

      <div className="workspace-shell">
        <aside className={`group-sidebar ${sidebarCollapsed ? "collapsed" : ""}`} aria-label="供应商分组">
          <div className="group-sidebar-title">分组</div>
          <div className="group-sidebar-list">
            {filteredGroups.map((group) => {
              const index = groups.findIndex((item) => item.id === group.id);
              return (
              <a
                className={`group-sidebar-button ${selectedGroup?.id === group.id ? "active" : ""}`}
                key={group.id}
                href={routeHash({ view: "providers", groupId: group.id })}
                aria-current={activeView === "providers" && selectedGroupId === group.id ? "page" : undefined}
                style={{
                  "--group-accent": paletteForGroup(group, index, status?.ui?.palette || "ocean").accent,
                  "--group-accent-hover": paletteForGroup(group, index, status?.ui?.palette || "ocean").hover,
                  "--group-accent-soft": paletteForGroup(group, index, status?.ui?.palette || "ocean").soft,
                  "--group-accent-shadow": paletteForGroup(group, index, status?.ui?.palette || "ocean").shadow,
                }}
                title={`${index + 1}. ${group.name} · ${groupListenerLabel(group)} · ${group.activeProviderCount ?? group.providerRefs?.length ?? 0} 个供应商${group.description ? ` · ${group.description}` : ""}`}
              >
                <span className="group-sidebar-number">{index + 1}</span>
                <span className="group-sidebar-name">{group.name}</span>
              </a>
              );
            })}
            {groupSearchOpen && (
              <div className="group-sidebar-search-popover">
                <Search size={14} />
                <input
                  autoFocus
                  value={groupSearch}
                  onChange={(event) => setGroupSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setGroupSearchOpen(false);
                  }}
                  placeholder="搜索分组..."
                  aria-label="搜索分组"
                />
                {groupSearch && <button type="button" onClick={() => setGroupSearch("")} title="清空搜索"><X size={13} /></button>}
              </div>
            )}
            {groupSearchOpen && groupSearch && !filteredGroups.length && (
              <div className="group-sidebar-search-empty">未找到分组</div>
            )}
          </div>
          <div className="group-sidebar-bottom">
            <button
              className="group-sidebar-action"
              type="button"
              title="搜索分组"
              onClick={() => setGroupSearchOpen((value) => !value)}
            >
              <Search size={16} />
              <span>搜索</span>
            </button>
            <button
              className="group-sidebar-action"
              type="button"
              title={sidebarCollapsed ? "展开分组名称" : "折叠分组名称"}
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              <ChevronDown className={sidebarCollapsed ? "rotate-270" : "rotate-90"} size={16} />
              <span>{sidebarCollapsed ? "展开" : "折叠"}</span>
            </button>
          </div>
        </aside>
        <section className="cc-content">
        <ViewScroll key={`${activeView}-${selectedGroup?.id || "none"}`} view={activeView} positions={viewScrollPositions}>
        {activeView === "providers" && (
          <div className="providers-view">
            <section className="hero-strip">
              <div>
                <p className="group-current-line">
                  当前分组：<strong>{selectedGroup?.name || "暂无分组"}</strong>
                  <span>{groupListenerLabel(selectedGroup)}</span>
                  <span>{selectedGroupProviderIds.size} 个供应商</span>
                </p>
              </div>
              <button className="button" onClick={() => navigate("add")}>
                <Plus size={16} />
                添加供应商
              </button>
            </section>

            <section className="metric-grid compact">
              <div className="metric-card-group">
                <Metric icon={<Server size={18} />} label="总请求" value={formatNumber(groupStatistics?.totalRequests)} />
                <Metric icon={<CheckCircle2 size={18} />} label="成功率" value={`${Number(groupStatistics?.successRate || 0).toFixed(1)}%`} />
                <Metric icon={<GitBranch size={18} />} label="故障转移" value={formatNumber(groupStatistics?.failoverCount)} />
                <Metric
                  icon={<Cpu size={18} />}
                  label="主服务 CPU"
                  value={`${Number(status?.resources?.cpuPercent || 0).toFixed(1)}%`}
                  detail={status?.resources?.cpuSampleWindowSeconds
                    ? `整机约 ${Number(status.resources.cpuPercentOfSystem || 0).toFixed(1)}% · ${status.resources.cpuParallelism || "-"} 核`
                    : `正在采样 · ${status?.resources?.cpuParallelism || "-"} 核`}
                />
                <Metric icon={<MemoryStick size={18} />} label="主服务 RSS 内存" value={formatMb(status?.resources?.memory?.rssMb)} />
                <Metric
                  icon={<MemoryStick size={18} />}
                  label="主服务堆内存"
                  value={`${formatMb(status?.resources?.memory?.heapUsedMb, false)} / ${formatMb(status?.resources?.memory?.heapTotalMb, false)} MB`}
                />
                <Metric icon={<Server size={18} />} label="主服务 PID" value={status?.resources?.pid || "-"} />
                <Metric icon={<Clock3 size={18} />} label="主服务运行时间" value={formatUptime(status?.uptimeSeconds)} />
              </div>
              <article className="metric-card provider-activity-card">
                <div className="provider-activity-heading">
                  <span><Shield size={18} />当前使用供应商</span>
                  {streamDiagnostics && <StreamDiagnostics stats={streamDiagnostics} />}
                </div>
                {groupActivity ? (
                  groupActivity.providers.length ? (
                    <div className="provider-activity-list">
                      {groupActivity.providers.map((provider) => (
                        <div className="provider-activity-item" key={provider.providerId}
                          title={`${provider.providerName} · 业务 ${provider.activeByKind.business || 0} · 检测 ${provider.activeByKind.health_check || 0} · 实验 ${provider.activeByKind.price_experiment || 0} · 诊断 ${provider.activeByKind.diagnostic || 0}（进行中请求数）`}>
                          <strong>{provider.providerName}</strong>
                          <small>{provider.activeRequests > 0 ? `${provider.activeRequests} 个进行中` : `近 ${groupActivity.windowMs / 1000} 秒`}</small>
                        </div>
                      ))}
                    </div>
                  ) : <strong>暂无流量</strong>
                ) : <strong>{status ? "重启后启用" : "等待状态"}</strong>}
                <small>{groupActivity
                  ? `本组请求进行中或结束后 ${groupActivity.windowMs / 1000} 秒内 · 含检测`
                  : "需新版后端提供实时流量统计"}</small>
              </article>
            </section>

            <section className="provider-list-toolbar">
              <div className="provider-search">
                <Search size={15} />
                <input
                  value={providerSearch}
                  onChange={(event) => setProviderSearch(event.target.value)}
                  placeholder="搜索供应商、地址或备注..."
                />
                {providerSearch && (
                  <button type="button" onClick={() => setProviderSearch("")} title="清空搜索">
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className="provider-list-meta">
                <span>当前分组 {selectedGroupProviderIds.size} 个</span>
                <span>显示 {filteredProviders.length} / {providers.length} 个供应商</span>
                <span>{proxyDraft?.autoFailoverEnabled ? "故障转移模式" : "单供应商模式"}</span>
              </div>
            </section>

            <section className="provider-list">
              {filteredProviders.map((provider) => (
                <ProviderCard
                  key={`${selectedGroup?.id}:${provider.id}`}
                  provider={provider}
                  isCurrent={Boolean(groupActivity?.providers.some((item) => item.providerId === provider.id) || groupActiveRequests.some((item) => item.providerId === provider.id))}
                  activeRequests={groupActiveRequests.filter((item) => item.providerId === provider.id)}
                  onCancelRequest={cancelActiveRequest}
                  isAutoFailoverEnabled={proxyDraft?.autoFailoverEnabled}
                  billingStats={providerBillingByName.get(provider.name)}
                  testStatus={providerTestResults[`${selectedGroupId}:${provider.id}`]}
                  onUpdate={updateProvider}
                  onLoadDetails={loadProviderDetails}
                  apiClient={groupApi}
                  onAction={providerAction}
                  onConfigureUsage={() => openUsageDashboard(provider)}
                  onOpenPriceLab={() => openUsageDashboard(provider, "experiment")}
                  onDiscoverOAuthFiles={discoverOAuthFiles}
                />
              ))}
              {!providers.length && (
                <ProviderEmptyState
                  title="还没有供应商"
                  description="添加 ht、k1、k2 或新的 Codex 中转站后，本地代理才能开始转发请求。"
                  action="添加供应商"
                  onAction={() => navigate("add")}
                />
              )}
              {providers.length > 0 && !filteredProviders.length && (
                <ProviderEmptyState
                  title="没有匹配结果"
                  description="调整搜索关键词，或清空搜索后查看全部供应商。"
                  action="清空搜索"
                  onAction={() => setProviderSearch("")}
                />
              )}
            </section>
          </div>
        )}

        {activeView === "settings" && (
          <div className="settings-view page-card">
          <section className="two-column">
            <article className="panel" id="strategy">
            <div className={`panel-head settings-section-head ${settingsSectionClass("settings-current-group")}`} id="settings-current-group">
              <PanelTitle title="当前分组" desc="端口、供应商开关和排序按组独立；供应商认证配置共用。" />
            </div>
            <div className="group-settings-summary">
              <strong>{selectedGroup?.name || "暂无分组"}</strong>
              <span>{groupListenerLabel(selectedGroup)}</span>
              <span>{selectedGroupProviderIds.size} 个供应商</span>
            </div>
            {selectedGroup && groupSettingsDraft && (
              <form className="current-group-form" onSubmit={saveGroupSettings}>
                <div className="form-grid">
                  <Field label="分组名称">
                    <input value={groupSettingsDraft.name} onChange={(event) => setGroupSettingsDraft({ ...groupSettingsDraft, name: event.target.value })} required />
                  </Field>
                  <Field label={selectedGroup.id === "default" ? "主服务端口（实际监听）" : "分组代理端口（保存后生效）"}>
                    <input type="number" min="1" max="65535" value={selectedGroup.id === "default" ? status?.port || "" : groupSettingsDraft.port} disabled={selectedGroup.id === "default"} onChange={(event) => setGroupSettingsDraft({ ...groupSettingsDraft, port: event.target.value })} required />
                  </Field>
                </div>
                {selectedGroup.id !== "default" && (
                  <label className="checkbox-row">
                    <input type="checkbox" checked={groupSettingsDraft.listenerEnabled} onChange={(event) => setGroupSettingsDraft({ ...groupSettingsDraft, listenerEnabled: event.target.checked })} />
                    <span>启用分组代理端口</span>
                  </label>
                )}
                {selectedGroup.listenerError && <p className="hint">{selectedGroup.listenerError}</p>}
                <Field label="用途说明">
                  <textarea rows="2" value={groupSettingsDraft.description} onChange={(event) => setGroupSettingsDraft({ ...groupSettingsDraft, description: event.target.value })} placeholder="例如：常规开发使用低价供应商" />
                </Field>
                <div className="form-grid group-theme-fields">
                  <Field label="分组按钮颜色">
                    <div className="group-color-control">
                      <label className="checkbox-row group-custom-toggle">
                        <input
                          type="checkbox"
                          checked={groupSettingsDraft.accentMode === "custom"}
                          onChange={(event) => {
                            const custom = event.target.checked;
                            setGroupSettingsDraft({
                              ...groupSettingsDraft,
                              accentMode: custom ? "custom" : "auto",
                              accent: custom ? groupSettingsDraft.accent
                                : paletteForGroup({ ...selectedGroup, theme: { ...selectedGroup.theme, accentMode: "auto", accentLocked: false } }, groups.indexOf(selectedGroup), status?.ui?.palette || "ocean").accent,
                              accentLocked: false,
                            });
                          }}
                        />
                        <span>自定义</span>
                      </label>
                      <div className="color-input-row">
                        <input
                          type="color"
                          value={groupSettingsDraft.accent}
                          disabled={groupSettingsDraft.accentMode !== "custom"}
                          onChange={(event) => setGroupSettingsDraft({ ...groupSettingsDraft, accentMode: "custom", accent: event.target.value })}
                        />
                        <span>{groupSettingsDraft.accent}</span>
                        <button
                          className={`group-lock-button ${groupSettingsDraft.accentLocked ? "active" : ""}`}
                          type="button"
                          disabled={groupSettingsDraft.accentMode !== "custom"}
                          aria-label={groupSettingsDraft.accentLocked ? "解锁分组颜色" : "锁定分组颜色"}
                          title={groupSettingsDraft.accentLocked ? "解锁后跟随全局色系" : "锁定当前颜色"}
                          onClick={() => setGroupSettingsDraft({ ...groupSettingsDraft, accentLocked: !groupSettingsDraft.accentLocked })}
                        >
                          {groupSettingsDraft.accentLocked ? <Lock size={15} /> : <Unlock size={15} />}
                        </button>
                      </div>
                    </div>
                  </Field>
                </div>
                <div className="actions">
                  <button className="button" type="submit" disabled={groupSettingsSaving}>{groupSettingsSaving ? "保存中" : "保存当前分组"}</button>
                </div>
              </form>
            )}
            <div className="settings-divider" />
            <div className={settingsSectionClass("settings-runtime")} id="settings-runtime">
              <details className="settings-collapsible">
                <summary><span>运行与持久化</span><small>查看服务状态、文件路径和写入情况</small></summary>
                <div className="settings-collapsible-body">
                  <p className="hint">启动时间：{status?.startedAt ? formatDateTime(status.startedAt) : "未知"}</p>
                  <p className="hint">配置文件：{status?.persistence?.configPath || "未知"}</p>
                  <p className="hint">运行版本：{status?.build ? `${status.build.version} · ${status.build.releaseId}` : "当前后端未提供版本标识"}</p>
                  <p className="hint">用量文件：{status?.persistence?.usagePath || "未知"}</p>
                  <p className="hint">最近写入：{status?.persistence?.lastWriteAt ? formatDateTime(status.persistence.lastWriteAt) : "本次启动尚无写入"}</p>
                  <p className="hint">写入失败：{formatNumber(status?.persistence?.failedWrites)}；{status?.persistence?.lastWriteError || "无当前错误"}</p>
                  {status?.persistence?.lastReadError && <p role="alert">日志读取失败：{status.persistence.lastReadError}</p>}
                  <p className="hint">最近业务请求 ID：{status?.lastRequestId || "暂无"}</p>
                  <p className="hint">代理认证：{status?.security?.proxyTokenConfigured ? "已开启" : "未设置令牌"}；管理认证：{status?.security?.adminTokenConfigured ? "已开启" : "未设置令牌"}</p>
                </div>
              </details>
            </div>
            <div className="settings-divider" />
            <div className={`panel-head ${settingsSectionClass("settings-theme")}`} id="settings-theme">
              <PanelTitle title="界面色系" desc="每个分组使用色系中的不同颜色；切换色系时保留已锁定的颜色。" />
              <button className="button" onClick={saveUiTheme} disabled={saving || !uiThemeDraft}>保存配色设置</button>
            </div>
            {uiThemeDraft && (
              <div className="palette-choice-grid">
                {UI_PALETTE_PRESETS.map((preset) => (
                  <button
                    className={`palette-choice ${uiThemeDraft.palette === preset.value ? "active" : ""}`}
                    key={preset.value}
                    type="button"
                    onClick={() => setUiThemeDraft({ ...uiThemeDraft, palette: preset.value })}
                  >
                    <span className="palette-choice-swatches">
                      {preset.groupAccents.slice(0, 4).map((color) => <i key={color} style={{ background: color }} />)}
                    </span>
                    <strong>{preset.label}</strong>
                  </button>
                ))}
              </div>
            )}
            {uiThemeDraft && (
              <label className="checkbox-row theme-follow-toggle">
                <input type="checkbox" checked={uiThemeDraft.groupThemeEnabled} onChange={(event) => setUiThemeDraft({ ...uiThemeDraft, groupThemeEnabled: event.target.checked })} />
                <span>整页配色跟随当前分组</span>
              </label>
            )}
            <div className="settings-divider" />
            <div className={`panel-head ${settingsSectionClass("settings-proxy")}`} id="settings-proxy">
              <PanelTitle title="代理策略" desc="所有分组共用重试与熔断设置；修改只影响后续请求。" />
              <button className="button" onClick={saveProxy} disabled={saving || !proxyDraft}>保存策略</button>
            </div>
            {proxyDraft && (
              <>
              <details className="settings-collapsible settings-advanced-details">
              <summary><span>高级参数与诊断</span><small>故障转移、超时、熔断器和连通性测试</small></summary>
              <div className="settings-collapsible-body">
              <div className="form-grid">
                <Field label="自动故障转移">
                  <select value={String(proxyDraft.autoFailoverEnabled)} onChange={(e) => setProxyDraft({ ...proxyDraft, autoFailoverEnabled: e.target.value === "true" })}>
                    <option value="true">开启</option>
                    <option value="false">关闭</option>
                  </select>
                </Field>
                <NumberField label="单次最大尝试数" value={proxyDraft.maxAttempts} onChange={(value) => setProxyDraft({ ...proxyDraft, maxAttempts: value })} />
                <NumberField label="首选供应商最大尝试数" value={proxyDraft.preferredProviderMaxAttempts} onChange={(value) => setProxyDraft({ ...proxyDraft, preferredProviderMaxAttempts: value })} />
                <NumberField label="其他供应商最大尝试数" value={proxyDraft.providerMaxAttempts} onChange={(value) => setProxyDraft({ ...proxyDraft, providerMaxAttempts: value })} />
                <NumberField label="流式首包超时 ms" value={proxyDraft.streamingFirstByteTimeoutMs} onChange={(value) => setProxyDraft({ ...proxyDraft, streamingFirstByteTimeoutMs: value })} />
                <NumberField label="流式静默超时 ms" value={proxyDraft.streamingIdleTimeoutMs} onChange={(value) => setProxyDraft({ ...proxyDraft, streamingIdleTimeoutMs: value })} />
                <NumberField label="安全回退等待 ms（0 为立即转发）" value={proxyDraft.streamingDeferredOutputGraceMs} onChange={(value) => setProxyDraft({ ...proxyDraft, streamingDeferredOutputGraceMs: value })} />
                <NumberField label="前导缓冲上限 KiB" value={proxyDraft.streamingDeferredBufferBytes / 1024} onChange={(value) => setProxyDraft({ ...proxyDraft, streamingDeferredBufferBytes: value * 1024 })} />
                <NumberField label="无有效进展超时 ms（0 为关闭）" value={proxyDraft.streamingProgressTimeoutMs} onChange={(value) => setProxyDraft({ ...proxyDraft, streamingProgressTimeoutMs: value })} />
                <NumberField label="非流式总超时 ms" value={proxyDraft.nonStreamingTimeoutMs} onChange={(value) => setProxyDraft({ ...proxyDraft, nonStreamingTimeoutMs: value })} />
                <NumberField label="失败阈值" value={proxyDraft.circuit.failureThreshold} onChange={(value) => setProxyDraft({ ...proxyDraft, circuit: { ...proxyDraft.circuit, failureThreshold: value } })} />
                <NumberField label="恢复成功阈值" value={proxyDraft.circuit.successThreshold} onChange={(value) => setProxyDraft({ ...proxyDraft, circuit: { ...proxyDraft.circuit, successThreshold: value } })} />
                <NumberField label="打开后等待 ms" value={proxyDraft.circuit.openTimeoutMs} onChange={(value) => setProxyDraft({ ...proxyDraft, circuit: { ...proxyDraft.circuit, openTimeoutMs: value } })} />
                <NumberField label="错误率阈值 0-1" step="0.05" value={proxyDraft.circuit.errorRateThreshold} onChange={(value) => setProxyDraft({ ...proxyDraft, circuit: { ...proxyDraft.circuit, errorRateThreshold: value } })} />
                <NumberField label="最小请求数" value={proxyDraft.circuit.minRequests} onChange={(value) => setProxyDraft({ ...proxyDraft, circuit: { ...proxyDraft.circuit, minRequests: value } })} />
              </div>
              <p className="hint">安全回退窗口从首包起计时，超时或缓冲已满后开始转发。无进展超时仅由文本、推理或工具事件续期，心跳不续期；已转发的响应中断后需由客户端重试。</p>
              <div className="settings-divider" />
              <div className={`connectivity-settings-head ${settingsSectionClass("settings-connectivity")}`} id="settings-connectivity">
                <div>
                  <h3>413 诊断</h3>
                  <p className="hint">只捕获下一次上游 413，后台各进行两次大请求与 CCOK 对照；诊断流量不写入用量统计。</p>
                </div>
                <button
                  className="button secondary"
                  type="button"
                  onClick={arm413Diagnostics}
                  disabled={diagnostics413?.armed || diagnostics413?.running}
                >
                  {diagnostics413?.running ? "诊断中" : diagnostics413?.armed ? "等待 413" : "等待下一次 413"}
                </button>
              </div>
              {diagnostics413?.last && (
                <p className="hint">最近诊断：{diagnostics413.last.ok ? "已完成" : "失败"}；日志：{diagnostics413.logPath}</p>
              )}
              <div className="settings-divider" />
              <div className="connectivity-settings-head">
                <div>
                  <h3>自动连通性测试</h3>
                  <p className="hint">选择后从当前时刻重新计时，不会立即触发测试。</p>
                </div>
                <button
                  className="button secondary connectivity-test-button"
                  type="button"
                  onClick={runConnectivityTest}
                  disabled={connectivitySaving || status?.connectivityTest?.running}
                  title="立即测试参与自动路由的供应商"
                >
                  {status?.connectivityTest?.running ? <Loader2 className="spin" size={16} /> : <Activity size={16} />}
                  {status?.connectivityTest?.running ? "测试中" : "立即测试"}
                </button>
              </div>
              <div className="connectivity-settings-grid">
                <Field label="自动测试间隔">
                  <select
                    value={connectivityDraft?.periodicIntervalMs ?? "never"}
                    onChange={(event) => updateConnectivityInterval(
                      event.target.value === "never" ? null : Number(event.target.value),
                    )}
                    disabled={connectivitySaving}
                  >
                    {CONNECTIVITY_INTERVAL_OPTIONS.map((option) => (
                      <option key={String(option.value)} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </Field>
                <div className="connectivity-timing" aria-live="polite">
                  <span><Clock3 size={15} />下次自动测试</span>
                  <strong>{formatConnectivityNextRun(status?.connectivityTest)}</strong>
                  {status?.connectivityTest?.lastRunAt && (
                    <small>上次完成：{formatDateTime(status.connectivityTest.lastRunAt)}</small>
                  )}
                </div>
              </div>
              <div className="connectivity-model-settings">
                <Field label="测试模型顺序">
                  <input
                    value={candidateModelsDraft ?? ""}
                    onChange={(event) => setCandidateModelsDraft(event.target.value)}
                    placeholder="gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol"
                    disabled={connectivitySaving}
                  />
                </Field>
                <button
                  className="button secondary connectivity-model-save"
                  type="button"
                  onClick={updateConnectivityModels}
                  disabled={connectivitySaving}
                >
                  保存模型顺序
                </button>
                <p className="hint">使用逗号分隔；当前模型不支持时，会按从左到右的顺序继续尝试。</p>
              </div>
              </div>
              </details>
              </>
            )}
            </article>

            <article className="panel">
            <div className={`panel-head settings-section-head ${settingsSectionClass("settings-groups")}`} id="settings-groups">
              <PanelTitle title="分组管理" desc="在这里新建空分组或复制当前分组的全部供应商配置。" />
            </div>
            <div className="group-management-list">
              {groups.map((group, index) => (
                <button
                  className={`group-management-item ${selectedGroup?.id === group.id ? "active" : ""}`}
                  type="button"
                  key={group.id}
                  onClick={() => navigate("settings", group.id, { section: route.section })}
                >
                  <span className="group-management-number">{index + 1}</span>
                  <span className="group-management-copy">
                    <strong>{group.name}</strong>
                    <small>{groupListenerLabel(group)} · {group.activeProviderCount ?? group.providerRefs?.length ?? 0} 个供应商</small>
                  </span>
                </button>
              ))}
            </div>
            <div className="settings-divider" />
            <div className="group-create-actions">
              <Field label="新分组名称">
                <input value={groupCreateDraft.name} onChange={(event) => setGroupCreateDraft({ ...groupCreateDraft, name: event.target.value })} placeholder="例如：论文写作" />
              </Field>
              <Field label="用途说明">
                <input value={groupCreateDraft.description} onChange={(event) => setGroupCreateDraft({ ...groupCreateDraft, description: event.target.value })} placeholder="可选" />
              </Field>
              <Field label="分组代理端口（新建后立即监听）">
                <input type="number" min="1" max="65535" value={groupCreateDraft.port} onChange={(event) => setGroupCreateDraft({ ...groupCreateDraft, port: event.target.value })} placeholder="自动分配" />
              </Field>
            </div>
            <div className="actions group-management-actions">
              <button className="button" type="button" onClick={() => createGroupFromSettings()} disabled={groupCreating}>{groupCreating ? "处理中" : "新建空分组"}</button>
              <button className="button secondary" type="button" onClick={() => createGroupFromSettings({ clone: true })} disabled={groupCreating || !selectedGroup}>复制当前分组</button>
            </div>
            <div className="settings-divider" />
            <div className={settingsSectionClass("settings-provider")} id="settings-provider">
              <PanelTitle title="添加供应商" desc="API Key 与 OAuth 文件路径仅保存在本机；OAuth 令牌不会写入 Lite 配置。" />
            </div>
            <ProviderForm draft={providerForm} onDraftChange={setProviderForm} onSubmit={addProvider} saving={saving} onDiscoverOAuthFiles={discoverOAuthFiles} />
            </article>
          </section>
          </div>
        )}

        {activeView === "add" && (
          <section className="page-card single">
            <article className="panel add-panel">
              <PanelTitle title="添加供应商" desc="API Key 与 OAuth 文件路径仅保存在本机；OAuth 令牌不会写入 Lite 配置。" />
              <ProviderForm draft={providerForm} onDraftChange={setProviderForm} onSubmit={addProvider} saving={saving} onDiscoverOAuthFiles={discoverOAuthFiles} />
            </article>
          </section>
        )}

        {activeView === "billing" && groupReady && (
          <UsageDashboard
            key={selectedGroup?.id}
            groupId={selectedGroup?.id}
            billing={groupBilling}
            providers={providers}
            providerFilter={usageProviderFilter}
            onProviderFilterChange={(provider) => openUsageDashboard(provider, route.section)}
            pricing={pricing}
            setPricing={setPricing}
            onSavePricing={savePricing}
            onRefresh={() => refresh()}
            apiClient={groupApi}
            activeSection={route.section}
            onSectionChange={(section) => openUsageDashboard(usageProviderFilter, section)}
          />
        )}

        <section className="panel log-panel">
          <PanelTitle title="事件日志" desc="展示当前网页管理台操作结果。" />
          <pre>{events.join("\n")}</pre>
        </section>
        </ViewScroll>
        </section>
      </div>
      <div className="notification-stack" aria-label="操作通知" aria-live="polite">
        {notifications.map((item) => <NotificationToast key={item.id} item={item} onDismiss={dismissNotification} />)}
      </div>
    </main>
  );
}

function NotificationToast({ item, onDismiss }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), 6500);
    return () => window.clearTimeout(timer);
  }, [item.id, onDismiss]);
  const Icon = item.tone === "success" ? CheckCircle2 : item.tone === "error" ? AlertCircle : Activity;
  return <div className={`notification-toast ${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>
    <Icon size={18} aria-hidden="true" />
    <p>{item.message}</p>
    <button type="button" aria-label="关闭通知" title="关闭通知" onClick={() => onDismiss(item.id)}><X size={15} /></button>
  </div>;
}

// 活动供应商是实时状态，流式诊断是本分组已记录的上游尝试。
function StreamDiagnostics({ stats }) {
  const panelId = useId();
  const firstByte = stats.firstByteAverageMs;
  const firstByteText = firstByte == null ? "暂无记录" : firstByte < 1000
    ? `${Math.round(firstByte)} 毫秒`
    : `${(firstByte / 1000).toFixed(1)} 秒`;
  const lastChunk = new Date(stats.latestLastChunkAt || NaN);
  const lastChunkText = Number.isFinite(lastChunk.getTime())
    ? `${lastChunk.getFullYear()} 年 ${lastChunk.getMonth() + 1} 月 ${lastChunk.getDate()} 日 ${lastChunk.getHours()} 时 ${lastChunk.getMinutes()} 分 ${lastChunk.getSeconds()} 秒`
    : "";
  const outcomes = [
    ["回复前失败，后来成功", stats.preOutputFailovers],
    ["回复前失败，未恢复", stats.preOutputFailures],
    ["回复已开始，中途失败", stats.midStreamDisconnects],
  ];
  const causes = [
    ["上游传输错误", stats.transportErrors, "连接供应商或读取响应时发生错误。"],
    ["客户端断开", stats.clientDisconnects, "下游连接提前关闭，例如客户端取消请求。"],
    ["等不到新数据", stats.idleTimeouts, "在规定时间内没有收到上游数据。"],
    ["等不到有效进展", stats.progressTimeouts, "在规定时间内没有新内容或其他有效进展。连接即使还在发心跳也会超时。"],
  ];
  return (
    <>
      <button
        className="info-hint-button stream-diagnostics-trigger"
        type="button"
        aria-label="查看流式诊断"
        title="流式诊断"
        popovertarget={panelId}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      <div className="provider-activity-diagnostics" id={panelId} popover="auto" role="region" aria-labelledby={`${panelId}-title`}>
        <h3 id={`${panelId}-title`}>流式诊断</h3>
        <p className="stream-diagnostics-scope">本分组累计 {formatNumber(stats.streamAttempts)} 次流式尝试</p>
        <dl className="stream-diagnostics-list">
          {outcomes.map(([label, count]) => (
            <div key={label}><dt>{label}</dt><dd>{formatNumber(count)} 次</dd></div>
          ))}
          <div><dt>平均等到上游首批数据</dt><dd>{firstByteText}</dd></div>
        </dl>
        <details className="stream-diagnostics-detail">
          <summary>原因与统计口径</summary>
          <dl className="stream-diagnostics-list">
            {causes.map(([label, count, description]) => (
              <div key={label}>
                <dt>{label}<small>{description}</small></dt>
                <dd>{formatNumber(count)} 次</dd>
              </div>
            ))}
            {lastChunkText && (
              <div><dt>最近记录到的上游数据</dt><dd><time dateTime={stats.latestLastChunkAt}>{lastChunkText}</time></dd></div>
            )}
          </dl>
          <p>失败项按上游尝试计数。同一请求可能尝试多次，一次失败也可能同时属于多种原因。</p>
          <p>首批数据平均等待时间来自 {formatNumber(stats.firstByteSamples)} 次有计时的尝试，成功或失败都可计入。最近数据时间也取自两类尝试。</p>
          <p>回复开始以代理向客户端发出流数据为准。首批数据从发起上游尝试开始计时，其中可能只有协议事件。</p>
        </details>
      </div>
    </>
  );
}

function Metric({ icon, label, value, detail }) {
  return (
    <article className="metric-card">
      <span>{icon}{label}</span>
      <div className="metric-value-row">
        <strong>{value ?? "0"}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </article>
  );
}

function formatMb(value, includeUnit = true) {
  const number = Number(value || 0);
  return includeUnit ? `${number.toFixed(1)} MB` : number.toFixed(1);
}

function formatUptime(value) {
  const seconds = Math.max(0, Number(value || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${remainMinutes}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function ProviderEmptyState({ title, description, action, onAction }) {
  return (
    <article className="provider-empty-state">
      <div className="provider-empty-icon">
        <Server size={20} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      <button className="cc-button cc-button-primary" onClick={onAction}>
        <Plus size={15} />
        {action}
      </button>
    </article>
  );
}

// 每个主视图使用独立的滚动容器，切换视图时不共享浏览器文档滚动条。
function ViewScroll({ view, positions, children }) {
  const containerRef = useRef(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const restore = () => {
      container.scrollTop = Number(positions.current.get(view) || 0);
    };
    restore();
    const frame = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(frame);
  }, [positions, view]);

  return (
    <div
      ref={containerRef}
      className="cc-view-scroll"
      onScroll={(event) => positions.current.set(view, event.currentTarget.scrollTop)}
    >
      {children}
    </div>
  );
}

function PanelTitle({ title, desc }) {
  return (
    <div>
      <h2>{title}</h2>
      <p>{desc}</p>
    </div>
  );
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 401 && data?.error?.type === "admin_auth_failed") {
      window.dispatchEvent(new Event("lite-auth-expired"));
    }
    throw Object.assign(new Error(data?.error?.message || data?.message || `HTTP ${response.status}`), { status: response.status, code: data?.error?.code });
  }
  return data;
}

function cloneProxy(proxy) {
  return proxy ? JSON.parse(JSON.stringify(proxy)) : null;
}

function normalizeProxyDraft(proxy) {
  return {
    ...proxy,
    maxAttempts: Number(proxy.maxAttempts || 1),
    preferredProviderMaxAttempts: Number(proxy.preferredProviderMaxAttempts || 6),
    providerMaxAttempts: Number(proxy.providerMaxAttempts || 2),
    retryScheduleChunkSize: Number(proxy.retryScheduleChunkSize || 2),
    maxRetryElapsedMs: Number(proxy.maxRetryElapsedMs || 300000),
    streamingFirstByteTimeoutMs: Number(proxy.streamingFirstByteTimeoutMs || 60000),
    streamingIdleTimeoutMs: Number(proxy.streamingIdleTimeoutMs || 0),
    streamingDeferredOutputGraceMs: Number(proxy.streamingDeferredOutputGraceMs ?? 1500),
    streamingDeferredBufferBytes: Number(proxy.streamingDeferredBufferBytes ?? 262144),
    streamingProgressTimeoutMs: Number(proxy.streamingProgressTimeoutMs ?? 0),
    nonStreamingTimeoutMs: Number(proxy.nonStreamingTimeoutMs || 600000),
    circuit: {
      failureThreshold: Number(proxy.circuit?.failureThreshold || 4),
      successThreshold: Number(proxy.circuit?.successThreshold || 2),
      openTimeoutMs: Number(proxy.circuit?.openTimeoutMs || 60000),
      errorRateThreshold: Number(proxy.circuit?.errorRateThreshold || 0.6),
      minRequests: Number(proxy.circuit?.minRequests || 10),
    },
  };
}

function cloneConnectivityTest(connectivityTest) {
  return connectivityTest
    ? { periodicIntervalMs: connectivityTest.periodicIntervalMs ?? null }
    : { periodicIntervalMs: 3 * 60 * 60_000 };
}

function formatConnectivityNextRun(connectivityTest) {
  if (!connectivityTest || connectivityTest.periodicIntervalMs === null) return "永不";
  if (connectivityTest.running) return "正在测试";
  if (!connectivityTest.nextRunAt) return "等待调度";
  return formatDateTime(connectivityTest.nextRunAt);
}

function formatConnectivityInterval(intervalMs) {
  if (intervalMs === null) return "永不";
  if (intervalMs === 30 * 60_000) return "0.5h";
  if (intervalMs < 24 * 60 * 60_000) return `${intervalMs / 60 / 60_000}h`;
  if (intervalMs === 30 * 24 * 60 * 60_000) return "1个月";
  return `${intervalMs / 24 / 60 / 60_000}d`;
}

function uniqueModelNames(value) {
  return [...new Set(String(value || "")
    .split(/[,，\s]+/)
    .map((model) => model.trim())
    .filter(Boolean))];
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "未知"
    : date.toLocaleString("zh-CN", { hour12: false });
}

function pricingToRows(pricing) {
  const rows = Object.entries(pricing || {}).map(([model, value]) => ({ model, ...value }));
  return rows.length ? rows : [{ model: "*", inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheCreationPerMillion: 0 }];
}

function AuthGate() {
  const [auth, setAuth] = useState(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/status").then((response) => {
      // 兼容尚未重启的旧服务：旧版没有认证状态接口，原有管理台仍可打开。
      if (response.status === 404) return { required: false, authenticated: true };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }).then(setAuth).catch((failure) => setError(`无法连接服务：${failure.message}`));
    const expired = () => setAuth({ required: true, authenticated: false });
    window.addEventListener("lite-auth-expired", expired);
    return () => window.removeEventListener("lite-auth-expired", expired);
  }, []);

  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ token }) });
      setToken("");
      setAuth({ required: true, authenticated: true });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  if (auth?.authenticated || auth?.required === false) return <App />;
  return (
    <main className="cc-app">
      <section className="page-card single">
        <form className="panel add-panel" onSubmit={login}>
          <h1>Lite CC Switch</h1>
          <p>{auth ? "请输入服务端配置的管理令牌。" : "正在连接服务…"}</p>
          {auth && <Field label="管理令牌"><input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="current-password" required /></Field>}
          {error && <p role="alert">{error}</p>}
          {auth && <button className="button" disabled={busy}> {busy ? "登录中…" : "登录"} </button>}
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<AuthGate />);
