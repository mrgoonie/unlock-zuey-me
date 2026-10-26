/**
 * Browser client and display helpers for the ai-tutor insights islands (/insights, /insights/pair and the
 * Settings panel). Learner endpoints are in src/pages/api/v1/insights/reports/**; the consent, settings,
 * pairing and device endpoints follow docs/insights-ingest-contract.md and the phase 1 route contracts.
 * Errors surface the server's Vietnamese message (settings-api.ts).
 */
import { apiRequest } from '../settings/settings-api';
import type { InsightQueueState, InsightReportView, InsightSession } from '../../lib/insights/learner-report-queries';

export type { InsightQueueState, InsightReportView, InsightSession };

export interface ReportsResponse {
  reports: InsightReportView[];
  nextCursor: string | null;
  sessions: InsightSession[];
  queue: InsightQueueState;
}

export interface ReportQuery {
  cursor?: string | null;
  from?: string | null;
  skill?: string | null;
  mission?: string | null;
  session?: string | null;
}

export function fetchReports(q: ReportQuery): Promise<ReportsResponse> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  const qs = params.toString();
  return apiRequest<ReportsResponse>(`/api/v1/insights/reports${qs ? `?${qs}` : ''}`);
}

export const rateReport = (id: string, useful: boolean) =>
  apiRequest<{ ok: true }>(`/api/v1/insights/reports/${encodeURIComponent(id)}/feedback`, 'POST', { useful });

export const deleteReport = (id: string) =>
  apiRequest<{ ok: true }>(`/api/v1/insights/reports/${encodeURIComponent(id)}`, 'DELETE');

export const deleteAllReports = () =>
  apiRequest<{ deleted: number }>('/api/v1/insights/reports/delete-all', 'POST', { confirm: 'XOA' });

// ---------- Settings, consent, devices, pairing (phase 1 endpoints) ----------

export interface InsightConsentState { analysis: boolean; shareOperator: boolean; proposals: boolean }
export interface InsightDevice { id: string; label: string; adapter: string; createdAt: string; lastUsedAt: string | null; expiresAt: string }
export interface InsightsSettings {
  enabled: boolean;
  member: boolean;
  consents: InsightConsentState;
  devices: InsightDevice[];
  queue: InsightQueueState;
  retentionDays: number;
}

export const fetchInsightsSettings = () => apiRequest<InsightsSettings>('/api/v1/insights/settings');

export const patchConsents = (patch: Partial<InsightConsentState>) =>
  apiRequest<{ consents: InsightConsentState }>('/api/v1/insights/consent', 'PATCH', patch);

export const revokeDevice = (id: string) =>
  apiRequest<unknown>(`/api/v1/insights/tokens/${encodeURIComponent(id)}`, 'DELETE');

export const confirmPairing = (userCode: string, approve: boolean) =>
  apiRequest<unknown>('/api/v1/insights/pair/confirm', 'POST', { userCode, approve });

// ---------- Display helpers ----------

const RUNTIME_LABELS: Record<string, string> = { 'claude-code': 'Claude Code' };
export const runtimeLabel = (runtime: string): string => RUNTIME_LABELS[runtime] ?? runtime;

export const RISK_KIND_LABELS: Record<string, string> = {
  unverified_claim: 'Dùng kết quả AI khi chưa kiểm chứng',
  sensitive_data_shared: 'Có dấu hiệu chia sẻ dữ liệu nhạy cảm',
  overreliance: 'Dựa vào AI quá nhiều',
  tool_error_ignored: 'Bỏ qua lỗi của công cụ',
};

/** "Nguồn: Claude Code · phân tích bởi ai-tutor (máy chủ) · dựa trên 3 lượt · mô hình …" */
export function provenanceLine(p: InsightReportView['provenance']): string {
  return `Nguồn: ${runtimeLabel(p.sourceRuntime)} · phân tích bởi ai-tutor (máy chủ) · dựa trên ${p.eventCount} lượt · mô hình ${p.model}`;
}

export const confidenceLabel = (c: number): string => {
  const pct = Math.round(Math.min(Math.max(c, 0), 1) * 100);
  return `độ tin cậy ${pct}%`;
};

const dateTime = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Saigon', dateStyle: 'short', timeStyle: 'short' });
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
}

/** The fixed disclaimer shown on /insights and in the drill-down. */
export const OBSERVABLE_ONLY_DISCLAIMER =
  'ai-tutor chỉ dựa trên những gì hiển thị trong phiên (lời nhắn của bạn, câu trả lời cuối, tên công cụ đã dùng). Nó không đọc được suy luận ẩn của mô hình AI.';
