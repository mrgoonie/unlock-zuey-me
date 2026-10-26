/** Export (JSON download) and erase-all-data with a typed "XOA" confirmation. */
import { useState } from 'react';
import { apiRequest, errorMessage } from './settings-api';

const CONFIRM_WORD = 'XOA';

export default function DataRightsPanel() {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const erase = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (typed.trim() !== CONFIRM_WORD) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/api/v1/me/delete', 'POST', { confirm: CONFIRM_WORD });
      setDone(true);
      window.setTimeout(() => window.location.assign('/'), 1500);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-ink-muted">Tải toàn bộ dữ liệu của bạn (tiến độ, bài nộp, điểm, tin nhắn với trợ lý) dưới dạng tệp JSON.</p>
        <a href="/api/v1/me/export" download className="btn-ghost mt-2">⬇️ Tải dữ liệu của tôi</a>
      </div>

      <form onSubmit={erase} className="flex flex-col gap-2 rounded-xl border border-danger/40 p-3">
        <p className="font-semibold text-danger">Xoá toàn bộ dữ liệu</p>
        <p className="text-sm text-ink-muted">
          Xoá vĩnh viễn tiến độ, bài nộp, ảnh, điểm, huy hiệu, chứng nhận và nhắc nhở. Không thể hoàn tác. Tài khoản zuey.me của bạn không bị ảnh hưởng.
        </p>
        <label htmlFor="delete-confirm" className="text-sm font-medium">
          Gõ <strong>{CONFIRM_WORD}</strong> (không dấu) để xác nhận
        </label>
        <input id="delete-confirm" className="field min-h-[44px]" value={typed} autoComplete="off" autoCapitalize="characters"
          spellCheck={false} onChange={(e) => setTyped(e.target.value)} disabled={busy || done} aria-describedby="delete-status" />
        <button type="submit" className="btn min-h-[44px] bg-danger text-white disabled:opacity-50"
          disabled={busy || done || typed.trim() !== CONFIRM_WORD}>
          {busy && !done ? 'Đang xoá…' : 'Xoá vĩnh viễn'}
        </button>
        <p id="delete-status" aria-live="polite" className={`text-sm ${error ? 'text-danger' : 'text-calm'}`}>
          {error ?? (done ? 'Đã xoá toàn bộ dữ liệu. Đang đưa bạn về trang đầu…' : '')}
        </p>
      </form>
    </div>
  );
}
