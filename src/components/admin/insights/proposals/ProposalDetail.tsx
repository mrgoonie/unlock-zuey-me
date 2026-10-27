/**
 * One proposal: cohort statistics, the policy gate's decision and reasons, the privacy check, the draft,
 * post-ship monitoring, "Sao chép nội dung issue", and the triage actions allowed from its status.
 * `ai-handle` approval needs the typed confirmation AI-HANDLE, and a second explicit tick for high risk.
 */
import { useEffect, useState } from 'react';
import CopyButton from '../../../ui/CopyButton';
import { errorMessage } from '../../../settings/settings-api';
import {
  CATEGORY_LABELS, DECISION_LABELS, formatDate, PRIVACY_HIT_LABELS, proposalsApi, REASON_LABELS, RISK_LABELS, STATUS_LABELS,
  type AutomationSettings, type ProposalAction, type ProposalDetail as Detail,
} from './proposals-admin-api';

const SECTIONS: Array<[keyof NonNullable<Detail['draft']>, string]> = [
  ['problem', 'Vấn đề'], ['affectedContext', 'Bối cảnh bị ảnh hưởng'], ['evidence', 'Bằng chứng tổng hợp'],
  ['proposedChange', 'Thay đổi tối thiểu đề xuất'], ['existingSolutionCheck', 'Đã có cấu hình/nội dung giải quyết chưa'],
  ['alternatives', 'Phương án khác'], ['tradeoffs', 'Đánh đổi'], ['acceptanceCriteria', 'Tiêu chí nghiệm thu'], ['blastRadius', 'Phạm vi ảnh hưởng'],
];

interface Props {
  id: string;
  settings: AutomationSettings;
  onClose: () => void;
  onChanged: () => void;
}

export default function ProposalDetail({ id, settings, onClose, onChanged }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [highRiskOk, setHighRiskOk] = useState(false);
  const [duplicateOf, setDuplicateOf] = useState('');

  useEffect(() => {
    let live = true;
    setDetail(null);
    setMessage(null);
    proposalsApi.detail(id).then((d) => live && setDetail(d)).catch((err) => live && setMessage({ kind: 'error', text: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [id]);

  const act = async (body: ProposalAction, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      setDetail(await proposalsApi.act(id, body));
      setMessage({ kind: 'ok', text: ok });
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  if (!detail) {
    return (
      <section className="card" aria-live="polite">
        {message ? <p role="alert" className="text-danger">{message.text}</p> : <p className="text-ink-muted">Đang tải đề xuất…</p>}
        <button type="button" className="btn-ghost mt-3" onClick={onClose}>Đóng</button>
      </section>
    );
  }

  const p = detail.proposal;
  const can = (...statuses: string[]) => statuses.includes(p.status);
  const githubOn = settings.githubMode !== 'off';
  const copyText = detail.issueMarkdown ? `# ${detail.issueTitle}\n\n${detail.issueMarkdown}` : '';
  // Mirrors fileProposal: ai-handle needs mode issues_ai_handle plus the gate's ai-handle tier or a recorded approval.
  const filesWithAiHandle = settings.githubMode === 'issues_ai_handle' && (p.gate.decision === 'issue_ai_handle' || p.aiHandleApprovedBy !== null);

  return (
    <section className="card flex flex-col gap-4" aria-labelledby="proposal-title">
      <div className="flex items-start justify-between gap-3">
        <h2 id="proposal-title" className="text-lg font-semibold">{detail.issueTitle}</h2>
        <button type="button" className="btn-ghost" onClick={onClose}>Đóng</button>
      </div>
      <div className="flex flex-wrap gap-2">
        <span className="chip">{STATUS_LABELS[p.status]}</span>
        <span className="chip">{RISK_LABELS[p.risk]}</span>
        <span className="chip">{CATEGORY_LABELS[p.category] ?? p.category}</span>
        <span className="chip">{p.area}</span>
        {p.aiHandle && <span className="chip">ai-handle</span>}
        <span className="chip">Bản nháp: {p.draftSource === 'ai' ? 'AI' : 'mẫu cố định'}</span>
      </div>
      <p className="text-sm">
        {p.stats.learners} người học · {p.stats.occurrences} lần · độ tin cậy trung bình {p.stats.avgConfidence.toFixed(2)} (14 ngày, chỉ người học đã đồng ý)
      </p>

      <div className="rounded-xl bg-line/40 p-3 text-sm">
        <h3 className="font-semibold">Cổng chính sách: {DECISION_LABELS[p.gate.decision]}</h3>
        {p.gate.reasons.length > 0 ? (
          <ul className="mt-1 list-disc pl-5">{p.gate.reasons.map((r) => <li key={r}>{REASON_LABELS[r] ?? r}</li>)}</ul>
        ) : <p className="mt-1">Không có lý do chặn.</p>}
        <p className="mt-2">
          Kiểm tra quyền riêng tư: {detail.privacyHits.length === 0 ? 'đạt (0 phát hiện)' : `không đạt: ${detail.privacyHits.map((h) => PRIVACY_HIT_LABELS[h] ?? h).join(', ')}`}
        </p>
      </div>

      {p.issue && (
        <p className="text-sm">Issue: <a className="underline" href={p.issue.url} target="_blank" rel="noopener noreferrer">#{p.issue.number}</a></p>
      )}
      {p.duplicateOf && <p className="text-sm">Trùng với: {p.duplicateOf}</p>}
      {detail.monitoring && (
        <p className="text-sm">
          Theo dõi sau triển khai ({formatDate(p.shippedAt)}): 14 ngày trước {detail.monitoring.before.occurrences} lần ({detail.monitoring.before.learners} người),
          14 ngày sau {detail.monitoring.after.occurrences} lần ({detail.monitoring.after.learners} người).
        </p>
      )}

      {detail.draft ? (
        <details className="text-sm">
          <summary className="flex min-h-[44px] cursor-pointer items-center font-medium">Bản nháp issue</summary>
          <dl className="mt-2 flex flex-col gap-2">
            {SECTIONS.map(([key, label]) => (
              <div key={key}>
                <dt className="font-medium">{label}</dt>
                <dd className="whitespace-pre-line text-ink-muted">{String(detail.draft?.[key] ?? '')}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : (
        <p className="text-sm text-ink-muted" data-testid="proposal-draft-withdrawn">
          Bản nháp đã được xoá vì không còn đủ người học đồng ý chia sẻ bằng chứng. Đề xuất sẽ chỉ có bản nháp mới khi có đủ bằng chứng mới.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {detail.issueMarkdown
          ? <CopyButton text={copyText} label="Sao chép nội dung issue" />
          : detail.draft && <p className="text-sm text-danger">Nội dung issue bị chặn vì chưa qua kiểm tra quyền riêng tư.</p>}
        {can('proposed') && <button type="button" className="btn-primary" disabled={busy} onClick={() => act({ action: 'accept' }, 'Đã chấp nhận đề xuất.')}>Chấp nhận</button>}
        {can('proposed', 'accepted') && <button type="button" className="btn-ghost" disabled={busy} onClick={() => act({ action: 'reject' }, 'Đã từ chối đề xuất.')}>Từ chối</button>}
        {can('proposed', 'accepted') && githubOn && detail.issueMarkdown && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => act({ action: 'file_issue' }, 'Đã xử lý tạo issue GitHub.')}>Tạo issue GitHub</button>
        )}
        {can('accepted', 'issue_filed') && <button type="button" className="btn-ghost" disabled={busy} onClick={() => act({ action: 'mark_shipped' }, 'Đã đánh dấu đã triển khai.')}>Đánh dấu đã triển khai</button>}
        {can('rejected', 'duplicate') && <button type="button" className="btn-ghost" disabled={busy} onClick={() => act({ action: 'reopen' }, 'Đã mở lại đề xuất.')}>Mở lại</button>}
      </div>

      {can('proposed', 'accepted') && githubOn && detail.issueMarkdown && (
        <p className="text-sm text-ink-muted" data-testid="proposal-file-note">
          Issue GitHub chỉ được tạo khi bạn bấm “Tạo issue GitHub”; hệ thống không tự tạo issue.
          {filesWithAiHandle ? ' Issue này sẽ được gắn nhãn ai-handle.' : ' Issue này sẽ không có nhãn ai-handle.'}
        </p>
      )}

      {can('proposed', 'accepted') && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span>Trùng với (số issue hoặc mã đề xuất, không bắt buộc)</span>
            <input className="field min-h-[44px]" value={duplicateOf} onChange={(e) => setDuplicateOf(e.target.value)} maxLength={300} />
          </label>
          <button type="button" className="btn-ghost" disabled={busy}
            onClick={() => act({ action: 'mark_duplicate', ...(duplicateOf.trim() ? { duplicateOf: duplicateOf.trim() } : {}) }, 'Đã đánh dấu trùng lặp.')}>
            Đánh dấu trùng lặp
          </button>
        </div>
      )}

      {settings.githubMode === 'issues_ai_handle' && can('proposed', 'accepted', 'issue_filed') && !p.aiHandleApprovedBy && (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-3 text-sm">
          <h3 className="font-semibold">Duyệt ai-handle thủ công</h3>
          <p>ai-handle không có nghĩa là tự merge: mọi thay đổi vẫn qua PR, CI và review. Gõ <strong>AI-HANDLE</strong> để xác nhận.</p>
          <input className="field min-h-[44px]" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" aria-label="Xác nhận AI-HANDLE" />
          {p.risk === 'high' && (
            <label className="flex min-h-[44px] items-center gap-2">
              <input type="checkbox" checked={highRiskOk} onChange={(e) => setHighRiskOk(e.target.checked)} />
              <span>Tôi đã xem xét: đề xuất rủi ro cao vẫn được gắn ai-handle</span>
            </label>
          )}
          <button type="button" className="btn-primary self-start" disabled={busy || confirm.trim() !== 'AI-HANDLE' || (p.risk === 'high' && !highRiskOk)}
            onClick={() => act({ action: 'approve_ai_handle', confirm: confirm.trim(), ...(p.risk === 'high' ? { confirmHighRisk: true as const } : {}) }, 'Đã duyệt ai-handle.')}>
            Duyệt ai-handle
          </button>
        </div>
      )}

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-danger' : 'text-calm'}`}>{message.text}</p>
      )}
    </section>
  );
}
