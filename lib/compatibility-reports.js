/** 合成检查报告：分组隔离的不可变文件，原子落盘，允许交接期间新旧工作进程并行保存。 */
import crypto from "node:crypto";
import { readOAuthFileHeaders } from "./oauth-file-source.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
function fingerprintValues(provider, sessionContext) {
  const fields = ["baseUrl", "apiKey", "authMode", "upstreamMode", "oauthFilePath", "sessionHeaders", "modelMap", "stripParams", "customHeaders", "proxyUrl"];
  const values = Object.fromEntries(fields.map((key) => [key, provider[key] ?? null]));
  if (provider.authMode === "client_session") values.sessionContext = sessionContext || null;
  return values;
}
export async function compatibilityFingerprint(provider, sessionContext) {
  const values = fingerprintValues(provider, sessionContext);
  if (provider.authMode === "oauth_file" && provider.oauthFilePath) {
    // 只保留摘要，认证文件更新后旧报告自动过期；读取失败不泄露本地路径。
    try { values.oauthDigest = hash(JSON.stringify(stable(await readOAuthFileHeaders(provider)))); }
    catch { values.oauthDigest = "unavailable"; }
  }
  return hash(JSON.stringify(stable(values)));
}

// 复用本次真正发出的认证头计算摘要；不再次读取 OAuth 文件，也不保存头内容。
export function compatibilityFingerprintFromHeaders(provider, headers) {
  let sessionContext;
  if (provider.authMode === "client_session") {
    sessionContext = Object.fromEntries((provider.sessionHeaders || []).map((name) => [name, headers.get(name)?.trim() || ""]));
    if (Object.values(sessionContext).some((value) => !value)) return "";
  }
  const values = fingerprintValues(provider, sessionContext);
  if (provider.authMode === "oauth_file") {
    const auth = { authorization: headers.get("authorization"), "chatgpt-account-id": headers.get("chatgpt-account-id") };
    if (!auth.authorization || !auth["chatgpt-account-id"]) return "";
    values.oauthDigest = hash(JSON.stringify(stable(auth)));
  }
  if (provider.authMode === "api_key") {
    const custom = new Headers(provider.customHeaders || {}).get("authorization");
    if (headers.get("authorization") !== (custom || (provider.apiKey ? `Bearer ${provider.apiKey}` : null))) return "";
  }
  return hash(JSON.stringify(stable(values)));
}

export function createCompatibilityReports(dataDir) {
  async function directory(groupId, create = false) {
    const base = await realpath(dataDir);
    let current = base;
    for (const part of ["compatibility-reports", hash(String(groupId))]) {
      current = path.join(current, part);
      if (create) await mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw new Error("检查报告目录不允许软链接");
    }
    return current;
  }
  const validId = (id, providerId) => new RegExp(`^${hash(String(providerId)).slice(0, 24)}-[0-9]{17}-[a-f0-9-]{36}$`).test(id);
  async function read(groupId, providerId, id) {
    if (!validId(id, providerId)) return null;
    try {
      const dir = await directory(groupId);
      const handle = await open(path.join(dir, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat(); if (!info.isFile() || info.size > 128 * 1024) return null;
        const report = JSON.parse(await handle.readFile("utf8"));
        return report.groupId === groupId && report.providerId === providerId && report.reportId === id ? report : null;
      } finally { await handle.close(); }
    } catch (error) { if (["ENOENT", "ELOOP"].includes(error.code) || error instanceof SyntaxError) return null; throw error; }
  }
  return {
    read,
    async save(report) {
      const dir = await directory(report.groupId, true);
      const reportId = `${hash(String(report.providerId)).slice(0, 24)}-${new Date().toISOString().replace(/\D/g, "")}-${crypto.randomUUID()}`;
      const target = path.join(dir, `${reportId}.json`); const temporary = `${target}.tmp`;
      const saved = { ...report, reportId, saved: true, savedAt: new Date().toISOString() };
      const bytes = JSON.stringify(saved);
      if (Buffer.byteLength(bytes) > 128 * 1024) throw new Error("检查报告超过大小限制");
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600); await handle.writeFile(bytes + "\n"); await handle.sync(); await handle.close(); handle = null;
        await rename(temporary, target);
        const dirHandle = await open(dir, "r"); try { await dirHandle.sync(); } finally { await dirHandle.close(); }
        return saved;
      } catch (error) { await handle?.close(); await unlink(temporary).catch(() => {}); throw error; }
    },
    async findForRequest(groupId, providerId, { model, configFingerprint, before }) {
      if (!configFingerprint || !Number.isFinite(Date.parse(before))) return { association: "not_recorded", reports: [] };
      let dir;
      try { dir = await directory(groupId); } catch (error) { if (error.code === "ENOENT") return { association: "no_match", reports: [] }; throw error; }
      const names = (await readdir(dir)).filter((name) => name.endsWith(".json") && validId(name.slice(0, -5), providerId)).sort().reverse();
      const reports = []; const modes = new Set(); let inspected = 0;
      for (const name of names.slice(0, 200)) {
        inspected += 1;
        const report = await read(groupId, providerId, name.slice(0, -5));
        if (!report || report.model !== model || report.configFingerprint !== configFingerprint || !["basic", "development"].includes(report.mode) || modes.has(report.mode)) continue;
        // 旧报告缺少完成时间，不能把尚在执行的检查当作请求开始前的证据。
        if (!report.savedAt || !Number.isFinite(Date.parse(report.savedAt)) || !Number.isFinite(Date.parse(report.checkedAt)) || Date.parse(report.savedAt) > Date.parse(before) || Date.parse(report.checkedAt) > Date.parse(before)) continue;
        modes.add(report.mode); reports.push(report);
        if (modes.size === 2) break;
      }
      return { association: reports.length ? "matched" : "no_match", reports, searchTruncated: inspected >= 200 && names.length > inspected };
    },
    async list(groupId, providerId, { page = 1, pageSize = 10 } = {}) {
      page = Math.max(1, Math.floor(Number(page) || 1)); pageSize = Math.max(1, Math.min(30, Math.floor(Number(pageSize) || 10)));
      let dir; try { dir = await directory(groupId); } catch (error) { if (error.code === "ENOENT") return { reports: [], page, pageSize, total: 0 }; throw error; }
      const names = (await readdir(dir)).filter((name) => name.endsWith(".json") && validId(name.slice(0, -5), providerId)).sort().reverse();
      const reports = [];
      for (const name of names.slice((page - 1) * pageSize, page * pageSize)) {
        const item = await read(groupId, providerId, name.slice(0, -5));
        if (item) { const { results, steps, requestTrace, ...summary } = item; reports.push(summary); }
      }
      return { reports, page, pageSize, total: names.length };
    },
  };
}
