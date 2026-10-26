/** Formatting helpers for the observer dashboard (server-rendered only). Times shown in Asia/Saigon. */
import { getMission } from '../../lib/content/loader';
import type { CompetencyId } from '../../lib/content/schema';

const dateTime = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Saigon', dateStyle: 'short', timeStyle: 'short' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00+07:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} giờ ${minutes % 60} phút`;
  return `${Math.round(hours / 24)} ngày`;
}

export const percent = (score01: number) => `${Math.round(score01 * 100)}%`;

export const missionTitle = (id: string | null | undefined): string => (id ? getMission(id)?.title ?? id : '—');

export const COMPETENCY_LABELS: Record<CompetencyId, string> = {
  discover: 'Khám phá', describe: 'Mô tả', delegate: 'Giao việc', verify: 'Kiểm chứng', operate: 'Vận hành', reflect: 'Đúc kết',
};

const EVENT_LABELS: Record<string, string> = {
  'onboarding.completed': 'Hoàn thành khảo sát đầu', 'onboarding.skipped': 'Bỏ qua khảo sát đầu',
  'mission.started': 'Bắt đầu mission', 'mission.step_viewed': 'Xem bước', 'mission.step_completed': 'Xong bước',
  'mission.abandoned': 'Bỏ dở mission', 'hint.requested': 'Xin gợi ý', 'coach.chat_sent': 'Chat với trợ lý',
  'evidence.submitted': 'Nộp bằng chứng', 'evaluation.completed': 'Được chấm điểm', 'evaluation.failed': 'Chấm điểm lỗi',
  'xp.granted': 'Nhận XP', 'badge.granted': 'Nhận huy hiệu', 'level.up': 'Lên cấp',
  'lab.started': 'Bắt đầu lab', 'lab.completed': 'Xong lab', 'concept.viewed': 'Xem khái niệm',
  'reflection.submitted': 'Viết đúc kết', 'certificate.issued': 'Nhận chứng nhận',
  'auth.signed_in': 'Đăng nhập', 'auth.guest_merged': 'Gộp tiến độ khách',
  'push.subscribed': 'Bật nhắc nhở', 'push.unsubscribed': 'Tắt nhắc nhở', 'push.sent': 'Được nhắc', 'push.opened': 'Mở lời nhắc',
  'consent.granted': 'Cho phép quan sát', 'consent.revoked': 'Tắt quan sát',
  'ai.budget_exceeded': 'Hết hạn mức AI', 'ai.fallback_used': 'Dùng AI dự phòng',
};

export const eventLabel = (name: string) => EVENT_LABELS[name] ?? name;

/** Compact "key: value" summary of event props (props never contain raw evidence text). */
export function propsSummary(props: Record<string, unknown>): string {
  return Object.entries(props)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`.slice(0, 80))
    .join(' · ');
}

/** Human labels for a mission's steps and answer fields, used to render evidence answers readably. */
export function answerLabels(missionId: string): Map<string, { title: string; fields: Map<string, string> }> {
  const out = new Map<string, { title: string; fields: Map<string, string> }>();
  for (const step of getMission(missionId)?.steps ?? []) {
    const fields = new Map<string, string>();
    if (step.type === 'guided-input') for (const f of step.fields) fields.set(f.id, f.label);
    if (step.type === 'ai-task') fields.set(step.capture.id, step.capture.label);
    if (step.type === 'verification') fields.set(step.notes.id, step.notes.label);
    if (step.type === 'reflection') fields.set(step.field_id, step.prompt);
    if (step.type === 'prediction') fields.set('confidence', 'Độ tự tin');
    out.set(step.id, { title: step.title, fields });
  }
  return out;
}

/** URL of an evidence image served by the engine (owner or consenting-observer admin only). */
export const evidenceImageUrl = (key: string) => `/api/v1/evidence/${key.split('/').map(encodeURIComponent).join('/')}`;
