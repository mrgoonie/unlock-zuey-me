/**
 * Settings → "ai-tutor & báo cáo học". Rendered only when insightsEnabledFor(env, learner). Shows the
 * collection status, the three separate consents (analysis, share with operator, anonymised proposals),
 * connected devices with revoke, and links to /skill and /insights. Data comes from the phase 1 endpoints:
 * GET /api/v1/insights/settings, PATCH /api/v1/insights/consent, DELETE /api/v1/insights/tokens/:id.
 * Turning analysis off takes effect on the server immediately (ingest answers 403 from the next turn).
 */
import { useEffect, useState } from 'react';
import {
  fetchInsightsSettings, formatDateTime, patchConsents, revokeDevice,
  type InsightConsentState, type InsightDevice, type InsightsSettings,
} from '../insights/insights-api';
import ToggleSwitch from './ToggleSwitch';

type Message = { kind: 'ok' | 'error'; text: string } | null;

const ADAPTER_LABELS: Record<string, string> = { 'claude-code': 'Claude Code' };

export function collectionStatus(s: Pick<InsightsSettings, 'consents' | 'devices'>, now: Date = new Date()): { label: string; tone: string } {
  if (!s.consents.analysis) return { label: 'Đã tạm dừng', tone: 'bg-line/60' };
  const active = s.devices.some((d) => Date.parse(d.expiresAt) > now.getTime());
  return active ? { label: 'Đang thu thập', tone: 'bg-calm/15 text-calm' } : { label: 'Chưa kết nối thiết bị', tone: 'bg-warn/15 text-warn' };
}

export default function InsightsSettingsPanel({ observerConsent }: { observerConsent: boolean }) {
  const [settings, setSettings] = useState<InsightsSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const load = () => {
    setLoadError(null);
    fetchInsightsSettings().then(setSettings).catch((err) => setLoadError(err instanceof Error ? err.message : 'Chưa tải được.'));
  };
  useEffect(load, []);

  const change = async (patch: Partial<InsightConsentState>, okText: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const { consents } = await patchConsents(patch);
      setSettings((s) => (s ? { ...s, consents } : s));
      setMessage({ kind: 'ok', text: okText });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Có lỗi xảy ra, thử lại sau nhé.' });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (d: InsightDevice) => {
    setBusy(true);
    setMessage(null);
    try {
      await revokeDevice(d.id);
      setSettings((s) => (s ? { ...s, devices: s.devices.filter((x) => x.id !== d.id) } : s));
      setMessage({ kind: 'ok', text: `Đã ngắt kết nối “${d.label}”. Thiết bị này không gửi được dữ liệu nữa.` });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Có lỗi xảy ra, thử lại sau nhé.' });
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p className="text-danger">Chưa tải được cài đặt ai-tutor. {loadError}</p>
        <button type="button" className="btn-ghost" onClick={load}>Thử lại</button>
      </div>
    );
  }
  if (!settings) return <p role="status" className="text-sm text-ink-muted">Đang tải cài đặt ai-tutor…</p>;

  const c = settings.consents;
  const status = collectionStatus(settings);
  return (
    <div className="flex flex-col gap-4" data-testid="insights-settings">
      <p className="text-sm text-ink-muted">
        Khi bạn đồng ý, kỹ năng ai-unlocked trong Claude Code gửi các lượt làm việc với AI (đã che thông tin bí mật ngay trên máy) để bộ phân tích nền ai-tutor trên máy chủ tạo báo cáo học tập cho riêng bạn. Mặc định mọi quyền đều tắt.
      </p>
      <p className="flex items-center gap-2 text-sm">
        Trạng thái: <span className={`chip ${status.tone}`} data-testid="insights-status">{status.label}</span>
      </p>

      <ToggleSwitch id="insights-analysis" checked={c.analysis} disabled={busy}
        label="Cho ai-tutor phân tích phiên làm việc với AI để tạo báo cáo cho riêng bạn"
        description="Khi bật, số liệu tổng hợp ẩn danh (chỉ là con số, chỉ hiện khi có từ 3 người học trở lên) có thể giúp người vận hành thấy xu hướng chung. Không ai thấy nội dung của bạn từ số liệu này."
        onChange={(next) => change({ analysis: next }, next
          ? 'Đã bật. Kết nối thiết bị để ai-tutor bắt đầu nhận các lượt làm việc.'
          : 'Đã dừng ngay. Thiết bị vẫn cài hook nhưng máy chủ sẽ từ chối mọi dữ liệu mới.')} />

      <ToggleSwitch id="insights-share" checked={c.shareOperator} disabled={busy || !c.analysis}
        label="Cho phép người vận hành xem báo cáo chi tiết của bạn (cần bật thêm quyền quan sát)"
        description={`Người vận hành chỉ xem được báo cáo (không xem lời nhắn gốc), và mỗi lần xem đều được ghi lại.${observerConsent ? '' : ' Quyền quan sát ở mục Quyền riêng tư đang tắt, nên hiện chưa ai xem được.'}`}
        onChange={(next) => change({ shareOperator: next }, next ? 'Đã cho phép người vận hành xem báo cáo chi tiết.' : 'Đã tắt. Người vận hành không còn xem được báo cáo của bạn.')} />

      <ToggleSwitch id="insights-proposals" checked={c.proposals} disabled={busy || !c.analysis}
        label="Cho phép dùng gợi ý đã ẩn danh để đề xuất cải thiện nền tảng"
        description="Chỉ dùng nhận xét đã ẩn danh về AI Unlocked, không trích lời bạn. Một đề xuất chỉ xuất hiện khi có từ 3 người học trở lên gặp cùng vấn đề."
        onChange={(next) => change({ proposals: next }, next ? 'Đã cho phép. Cảm ơn bạn đã giúp cải thiện AI Unlocked.' : 'Đã tắt. Báo cáo của bạn không còn được dùng cho đề xuất.')} />

      {!c.analysis && <p className="text-sm text-ink-muted">Bật quyền phân tích trước để dùng hai quyền còn lại.</p>}

      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">Thiết bị đã kết nối</h3>
        {settings.devices.length === 0 ? (
          <p className="text-sm text-ink-muted">Chưa có thiết bị nào. Cài kỹ năng ai-unlocked trong Claude Code để kết nối.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {settings.devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3 text-sm">
                <span>
                  <span className="font-medium">{d.label}</span> · {ADAPTER_LABELS[d.adapter] ?? d.adapter}
                  <span className="block text-ink-muted">Dùng gần nhất: {formatDateTime(d.lastUsedAt)} · hết hạn {formatDateTime(d.expiresAt)}</span>
                </span>
                <button type="button" className="btn-ghost text-sm" disabled={busy} aria-label={`Ngắt kết nối ${d.label}`} onClick={() => revoke(d)}>
                  Ngắt kết nối
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <a href="/skill" className="btn-ghost text-sm">Cài kỹ năng ai-unlocked</a>
          <a href="/insights" className="btn-ghost text-sm">🧭 Xem báo cáo ai-tutor</a>
        </div>
      </div>

      <p className="text-sm text-ink-muted">
        Báo cáo được giữ {settings.retentionDays} ngày. Mục “Dữ liệu của bạn” bên dưới (tải về và xoá toàn bộ) cũng bao gồm dữ liệu ai-tutor.
      </p>
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-danger' : 'text-calm'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
