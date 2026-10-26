/**
 * Device pairing approval (/insights/pair). Shows the code from the terminal (editable), the device label
 * and adapter, a plain list of what is sent and what never is, and requires ticking the analysis consent
 * when it is not on yet. "Đồng ý" grants that consent first (PATCH /api/v1/insights/consent) and then
 * approves the code; "Từ chối" denies it. The ingestion token itself never reaches this page: the CLI
 * receives it by polling.
 */
import { useEffect, useState } from 'react';
import { confirmPairing, fetchInsightsSettings, patchConsents } from './insights-api';

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

interface Props { initialCode: string; device: PairDevice | null }

const ADAPTER_LABELS: Record<string, string> = { 'claude-code': 'Claude Code' };

export default function PairApproval({ initialCode, device }: Props) {
  const [code, setCode] = useState(initialCode);
  const [analysis, setAnalysis] = useState<boolean | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'denied' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetchInsightsSettings()
      .then((s) => setAnalysis(s.consents.analysis))
      .catch(() => setAnalysis(false)); // unknown → ask for consent explicitly; granting it again is harmless
  }, []);

  const normalized = normalizeCode(code);
  const showDevice = device && normalized === normalizeCode(initialCode);
  const needsConsent = analysis !== true;
  const done = result?.kind === 'ok' || result?.kind === 'denied';

  const decide = async (approve: boolean) => {
    if (!normalized) return;
    setBusy(true);
    setResult(null);
    try {
      if (approve && needsConsent) {
        const r = await patchConsents({ analysis: true });
        setAnalysis(r.consents.analysis);
      }
      await confirmPairing(normalized, approve);
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

      {needsConsent && analysis !== null && (
        <label className="choice">
          <input type="checkbox" className="h-5 w-5 shrink-0" checked={agreed} required disabled={busy || done}
            onChange={(e) => setAgreed(e.target.checked)} />
          <span className="text-sm">
            Cho ai-tutor phân tích phiên làm việc với AI để tạo báo cáo cho riêng bạn. Bạn có thể tắt bất cứ lúc nào trong Cài đặt; khi tắt, máy chủ từ chối mọi dữ liệu mới ngay lập tức.
          </span>
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy || done || !normalized || analysis === null || (needsConsent && !agreed)}>
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
