/** Browser client and Vietnamese labels for the admin proposal triage islands. */
import { apiRequest } from '../../../settings/settings-api';
import type { GateDecisionKind, GateReason, ProposalStatus, RiskLevel } from '../../../../lib/insights/insight-types';
import type { ProposalDetail, AutomationSettings } from '../../../../lib/insights/proposal-stage';
import type { ProposalSummary } from '../../../../lib/insights/proposal-store';

export type { AutomationSettings, ProposalDetail, ProposalSummary };

export type ProposalAction =
  | { action: 'accept' | 'reject' | 'reopen' | 'file_issue' }
  | { action: 'mark_duplicate'; duplicateOf?: string }
  | { action: 'mark_shipped'; shippedRef?: string }
  | { action: 'approve_ai_handle'; confirm: string; confirmHighRisk?: true };

const BASE = '/api/v1/admin/insights';

export const proposalsApi = {
  list: () => apiRequest<{ proposals: ProposalSummary[]; settings: AutomationSettings }>(`${BASE}/proposals`),
  detail: (id: string) => apiRequest<ProposalDetail>(`${BASE}/proposals/${encodeURIComponent(id)}`),
  act: (id: string, body: ProposalAction) => apiRequest<ProposalDetail>(`${BASE}/proposals/${encodeURIComponent(id)}`, 'PATCH', body),
  setSafeAuto: (safeAutoImplement: boolean) =>
    apiRequest<AutomationSettings>(`${BASE}/settings`, 'PATCH', { safeAutoImplement, confirm: 'BAT' }),
};

/** Triage columns in workflow order (`filing` is shown inside "Đã tạo issue" while it runs). */
export const STATUS_COLUMNS: ProposalStatus[] = ['proposed', 'duplicate', 'accepted', 'rejected', 'issue_filed', 'shipped', 'monitored'];

export const STATUS_LABELS: Record<ProposalStatus, string> = {
  proposed: 'Đề xuất mới', duplicate: 'Trùng lặp', accepted: 'Đã chấp nhận', rejected: 'Đã từ chối',
  filing: 'Đang tạo issue', issue_filed: 'Đã tạo issue', shipped: 'Đã triển khai', monitored: 'Đang theo dõi',
};

export const RISK_LABELS: Record<RiskLevel, string> = { low: 'Rủi ro thấp', medium: 'Rủi ro trung bình', high: 'Rủi ro cao' };

export const DECISION_LABELS: Record<GateDecisionKind, string> = {
  none: 'Bị chặn',
  proposal: 'Chỉ là đề xuất trong dashboard',
  issue: 'Đủ điều kiện tạo issue (không có ai-handle)',
  issue_ai_handle: 'Đủ điều kiện tạo issue kèm ai-handle',
};

export const REASON_LABELS: Record<GateReason, string> = {
  personal_preference: 'Sở thích cá nhân, không phải vấn đề chung',
  cohort_too_small: 'Chưa đủ số người học gặp cùng vấn đề',
  low_confidence: 'Độ tin cậy của bằng chứng còn thấp',
  privacy: 'Nội dung chưa qua kiểm tra quyền riêng tư',
  github_off: 'Chưa bật tạo issue GitHub',
  no_token: 'Chưa cấu hình token GitHub',
  risk_not_low: 'Mức rủi ro không thấp, cần người vận hành duyệt',
  category_not_auto: 'Loại đề xuất này không được tự động xử lý',
  denylist: 'Chạm vùng nhạy cảm (bảo mật, danh tính, phân quyền, thanh toán, dữ liệu)',
  safe_auto_off: 'Chưa bật “tự động xử lý an toàn”',
  daily_cap: 'Đã đạt giới hạn issue trong ngày',
};

export const CATEGORY_LABELS: Record<string, string> = { bug: 'Lỗi', content: 'Nội dung', ux: 'Trải nghiệm', feature: 'Tính năng' };

export const PRIVACY_HIT_LABELS: Record<string, string> = {
  redaction: 'còn dữ liệu nhạy cảm', internal_id: 'có mã định danh nội bộ', email: 'có email', url: 'có đường dẫn ngoài unlock.zuey.me',
  verbatim_evidence: 'chép nguyên văn bằng chứng', forbidden_term: 'có tên người học',
};

export const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Saigon', dateStyle: 'short', timeStyle: 'short' }) : '—';
