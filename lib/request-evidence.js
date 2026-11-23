/** 请求证据按需查询：仅关联请求开始前、同组同模型同配置的报告；不请求供应商，也不改变历史。 */
import { exportCompatibilityReport } from "./compatibility-report-format.js";

export async function buildRequestEvidence(log, { compatibilityReports, recoveryEvidence }) {
  const groupId = log.groupId || "default";
  const refs = [...new Set([log.routeSnapshot?.recovery?.confirmationEventId, log.routeSnapshot?.recovery?.migrationEventId].filter(Boolean))];
  const recoveries = [];
  let unavailableRecoveries = 0;
  for (const id of refs) {
    const event = await recoveryEvidence.read(groupId, id).catch(() => null);
    if (event && event.model === log.requestModel && event.providerId === log.routeSnapshot.recovery.providerId) recoveries.push(event);
    else unavailableRecoveries += 1;
  }
  const checked = new Set(); const reports = [];
  for (const attempt of log.providerAttempts || []) {
    if (attempt.outcome === "skipped") continue;
    const key = JSON.stringify([attempt.providerId, attempt.configFingerprint]);
    if (checked.has(key)) continue;
    checked.add(key);
    if (reports.length >= 20) break;
    let found;
    try { found = await compatibilityReports.findForRequest(groupId, attempt.providerId, { model: log.requestModel, configFingerprint: attempt.configFingerprint, before: log.requestStartedAt }); }
    catch { found = { association: "unavailable", reports: [] }; }
    reports.push({ providerId: attempt.providerId, providerName: attempt.providerName, association: found.association, searchTruncated: Boolean(found.searchTruncated),
      reports: found.reports.map((report) => ({ reportId: report.reportId, ...exportCompatibilityReport({ ...report, stale: false }) })) });
  }
  return { version: 1, requestId: log.requestId || "", recoveries, unavailableRecoveries, reports };
}
