/**
 * GitHub automation panel: effective mode, whether a token is configured (a yes/no only), today's issue
 * count, and the `safe_auto_implement` toggle. Turning the toggle on needs the typed confirmation "BAT".
 */
import { useState } from 'react';
import { errorMessage } from '../../../settings/settings-api';
import ToggleSwitch from '../../../settings/ToggleSwitch';
import { proposalsApi, type AutomationSettings } from './proposals-admin-api';

const MODE_LABELS: Record<AutomationSettings['githubMode'], string> = {
  off: 'Tắt: chỉ tạo đề xuất trong dashboard',
  issues: 'Tạo issue GitHub khi người vận hành bấm “Tạo issue GitHub” (không gắn ai-handle)',
  issues_ai_handle: 'Tạo issue GitHub khi người vận hành bấm “Tạo issue GitHub”, có thể gắn ai-handle khi đủ điều kiện',
};

export default function OperatorAutomationSettings({ settings, onChange }: { settings: AutomationSettings; onChange: (s: AutomationSettings) => void }) {
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const turningOn = !settings.safeAutoImplement;

  const toggle = async (next: boolean) => {
    if (next && confirmText.trim().toUpperCase() !== 'BAT') {
      setMessage({ kind: 'error', text: 'Gõ BAT vào ô xác nhận để bật tự động xử lý an toàn.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const s = await proposalsApi.setSafeAuto(next);
      onChange(s);
      setConfirmText('');
      setMessage({ kind: 'ok', text: s.safeAutoImplement ? 'Đã bật tự động xử lý an toàn.' : 'Đã tắt tự động xử lý an toàn.' });
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card flex flex-col gap-3" aria-labelledby="automation-heading">
      <h2 id="automation-heading" className="text-lg font-semibold">Tự động hoá GitHub</h2>
      {!settings.tokenConfigured && (
        <p role="status" className="rounded-xl bg-line/40 p-3 text-sm">Chưa cấu hình GitHub: chỉ tạo đề xuất trong dashboard</p>
      )}
      <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
        <dt className="text-ink-muted">Chế độ hiệu lực</dt>
        <dd>{MODE_LABELS[settings.githubMode]}</dd>
        <dt className="text-ink-muted">Token GitHub</dt>
        <dd>{settings.tokenConfigured ? 'Đã cấu hình' : 'Chưa cấu hình'}</dd>
        <dt className="text-ink-muted">Issue đã tạo hôm nay</dt>
        <dd>{settings.issuesFiledToday} / {settings.dailyCap}</dd>
      </dl>
      <ToggleSwitch id="safe-auto-implement" label="Tự động xử lý an toàn (ai-handle)"
        description="Chỉ có tác dụng khi chế độ là issues_ai_handle. Khi bật, issue do người vận hành tạo cho đề xuất rủi ro thấp về nội dung hoặc lỗi, đủ từ 3 người học, qua kiểm tra quyền riêng tư và không chạm vùng nhạy cảm sẽ được gắn ai-handle. Hệ thống không bao giờ tự tạo issue. ai-handle không có nghĩa là tự merge: mọi thay đổi vẫn qua PR, CI và review."
        checked={settings.safeAutoImplement} disabled={busy} onChange={toggle} />
      {turningOn && (
        <label className="flex flex-col gap-1 text-sm">
          <span>Gõ <strong>BAT</strong> để xác nhận trước khi bật</span>
          <input className="field min-h-[44px]" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </label>
      )}
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-danger' : 'text-calm'}`}>
          {message.text}
        </p>
      )}
    </section>
  );
}
