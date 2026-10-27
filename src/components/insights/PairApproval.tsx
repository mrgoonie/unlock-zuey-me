/**
 * Device pairing approval (/insights/pair). Shows the code from the terminal (editable), the device label
 * and adapter, a plain list of what is sent and what never is, and the consents that are not on yet as
 * pre-ticked boxes the learner can untick: analysis (required to approve) and operator sharing (optional;
 * grants both insight share_operator and learners.observer_consent, which per-learner detail needs, and its
 * copy lists everything observer access shows). "Đồng ý" sends the ticked consents with the approval
 * (POST /api/v1/insights/pair/confirm `grant`), and the server grants them only while the code is pending.
 * Nothing here ever revokes a consent. "Từ chối" denies the code. The ingestion token itself never reaches this page: the CLI
 * receives it by polling.
 */
import { useEffect, useState } from 'react';
import { SEES } from '../settings/ObserverConsentToggle';
import { confirmPairing, fetchInsightsSettings, type InsightConsentState } from './insights-api';

const CODE_ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/** Mirrors normalizeUserCode (ingest-contract.ts) without bundling zod into the island. */
export function normalizeCode(input: string): string | null {
  const bare = input.toUpperCase().replace(/[\s-]/g, '');
  return CODE_ALPHABET.test(bare) ? `${bare.slice(0, 4)}-${bare.slice(4)}` : null;
}

const SENT = [
  'Lời nhắn bạn gửi cho AI và câu trả lời cuối của AI trong mỗi lượt, sau khi đã che thông tin bí mật (khoá API, mật khẩu, email, số điện thoại…) ngay trên máy bạn.',
  'Tên các công cụ AI đã dùng và việc chúng chạy thành công hay lỗi (không gửi nội dung công cụ).',
  'Mission và lượt làm trên AI Unlocked nếu phiên có dùng công cụ MCP của AI Unlocked.',
];
const NEVER_SENT = [
  'Nội dung tệp, thư mục làm việc, tham số và kết quả của công cụ.',
  'Suy luận ẩn của mô hình AI (ai-tutor không đọc được phần này).',
  'Mã truy cập của thiết bị: nó chỉ nằm trên máy bạn, không đi qua cuộc trò chuyện với AI.',
];

export interface PairDevice { label: string; adapter: string }

interface Props { initialCode: string; device: PairDevice | null; observerConsent: boolean }

const ADAPTER_LABELS: Record<string, string> = { 'claude-code': 'Claude Code' };

export default function PairApproval({ initialCode, device, observerConsent }: Props) {
  const [code, setCode] = useState(initialCode);
  const [consents, setConsents] = useState<InsightConsentState | null>(null);
  const [agreed, setAgreed] = useState(true);
  const [share, setShare] = useState(true);
  const [observer, setObserver] = useState(observerConsent);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'denied' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetchInsightsSettings()
      .then((s) => setConsents(s.consents))
      // Unknown → show both boxes; granting a consent that is already on is harmless.
      .catch(() => setConsents({ analysis: false, shareOperator: false, proposals: false }));
  }, []);

  const normalized = normalizeCode(code);
  const showDevice = device && normalized === normalizeCode(initialCode);
  const needsConsent = consents !== null && !consents.analysis;
  const needsShare = consents !== null && !(consents.shareOperator && observer);
  const done = result?.kind === 'ok' || result?.kind === 'denied';

  const decide = async (approve: boolean) => {
    if (!normalized) return;
    setBusy(true);
    setResult(null);
    try {
      const grantShare = needsShare && share;
      const grant = approve && (needsConsent || grantShare) ? { share: grantShare } : undefined;
      await confirmPairing(normalized, approve, grant);
      if (grant && consents) {
        // Granted with the approval: hide the boxes so nothing on screen suggests they can still be unticked.
        setConsents({ ...consents, analysis: true, shareOperator: consents.shareOperator || grantShare });
        if (grantShare) setObserver(true);
      }
      setResult(approve
        ? { kind: 'ok', text: 'Đã kết nối thiết bị. Quay lại terminal: thiết bị sẽ tự nhận kết nối trong vài giây.' }
        : { kind: 'denied', text: 'Đã từ chối. Thiết bị này không được kết nối.' });
    } catch (err) {
      setResult({ kind: 'error', text: err instanceof Error ? err.message : 'Có lỗi xảy ra, thử lại sau nhé.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void decide(true); }} aria-describedby="pair-result">
      <div className="card flex flex-col gap-2">
        <label htmlFor="pair-code" className="font-semibold">Mã hiển thị trong terminal</label>
        <input id="pair-code" className="field min-h-[44px] font-mono text-lg tracking-widest" value={code} maxLength={16}
          autoComplete="off" autoCapitalize="characters" spellCheck={false} inputMode="text" placeholder="XXXX-XXXX"
          aria-invalid={code !== '' && !normalized} aria-describedby="pair-code-hint" disabled={busy || done}
          onChange={(e) => setCode(e.target.value)} />
        <p id="pair-code-hint" className="text-sm text-ink-muted">
          {code !== '' && !normalized ? 'Mã gồm 8 ký tự, dạng XXXX-XXXX.' : 'Chỉ đồng ý nếu mã này trùng với mã trên máy của bạn.'}
        </p>
        {showDevice && (
          <p className="text-sm" data-testid="pair-device">
            Thiết bị: <strong>{device.label}</strong> · {ADAPTER_LABELS[device.adapter] ?? device.adapter}
          </p>
        )}
      </div>

      <div className="card grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <h2 className="font-semibold">Sẽ được gửi</h2>
          <ul className="mt-1 list-disc space-y-1 pl-5">{SENT.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
        <div>
          <h2 className="font-semibold">Không bao giờ gửi</h2>
          <ul className="mt-1 list-disc space-y-1 pl-5">{NEVER_SENT.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      </div>

      {needsConsent && (
        <label className="choice">
          <input type="checkbox" className="h-5 w-5 shrink-0" checked={agreed} required disabled={busy || done}
            data-testid="pair-consent-analysis" onChange={(e) => setAgreed(e.target.checked)} />
          <span className="text-sm">
            Cho ai-tutor phân tích phiên làm việc với AI để tạo báo cáo cho riêng bạn (bắt buộc để kết nối). Bạn có thể tắt bất cứ lúc nào trong Cài đặt; khi tắt, máy chủ từ chối mọi dữ liệu mới ngay lập tức.
          </span>
        </label>
      )}
      {needsShare && (
        <div className="flex flex-col gap-2">
          <label className="choice">
            <input type="checkbox" className="h-5 w-5 shrink-0" checked={share && (agreed || !needsConsent)}
              disabled={busy || done || (needsConsent && !agreed)} data-testid="pair-consent-share" onChange={(e) => setShare(e.target.checked)} />
            <span className="text-sm">
              Cho người vận hành AI Unlocked (quản trị viên) quan sát hành trình học của bạn trên AI Unlocked và xem báo cáo ai-tutor, để hướng dẫn bạn tốt hơn. Không bắt buộc: bỏ chọn nếu bạn không muốn.
            </span>
          </label>
          <details className="text-sm">
            <summary className="cursor-pointer font-semibold">Người vận hành sẽ thấy gì</summary>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {SEES.map((s) => <li key={s}>{s}</li>)}
              <li>Báo cáo ai-tutor về các phiên Claude Code (không có lời nhắn gốc). Mỗi lần xem báo cáo ai-tutor đều được ghi lại; phần hành trình trên AI Unlocked thì không.</li>
            </ul>
          </details>
          <p className="text-sm text-ink-muted">
            Muốn dừng sau này, vào Cài đặt và tắt cả hai: “Cho phép người quan sát xem hành trình học” ở mục Quyền riêng tư, và “Cho phép người vận hành xem báo cáo chi tiết của bạn (cần bật thêm quyền quan sát)” ở mục ai-tutor &amp; báo cáo học.
          </p>
        </div>
      )}
      {(needsConsent || needsShare) && (
        <p className="text-sm text-ink-muted">Các ô trên được chọn sẵn. Bấm “Đồng ý” nghĩa là bạn đồng ý với những ô đang được chọn.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy || done || !normalized || consents === null || (needsConsent && !agreed)}>
          {busy ? 'Đang xử lý…' : 'Đồng ý'}
        </button>
        <button type="button" className="btn-ghost" disabled={busy || done || !normalized} onClick={() => decide(false)}>Từ chối</button>
      </div>
      <p id="pair-result" role={result?.kind === 'error' ? 'alert' : 'status'} aria-live="polite"
        className={`text-sm ${result?.kind === 'error' ? 'text-danger' : 'text-calm'}`}>
        {result?.text ?? ''}
      </p>
      {result?.kind === 'ok' && <a href="/insights" className="btn-ghost self-start">Xem báo cáo ai-tutor</a>}
    </form>
  );
}
