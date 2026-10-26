/**
 * "Bỏ lượt này": a quiet button that expands an inline confirm step (no modal, so it works the same with
 * touch, keyboard and screen readers). Opening moves focus to the safe choice ("Làm tiếp"); Escape or
 * "Làm tiếp" closes it and returns focus to the trigger. Confirming abandons the run on the server and the
 * runner opens a fresh run.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  /** Abandons the run and starts a new one. Resolves to an error message, or null on success. */
  onAbandon: () => Promise<string | null>;
}

export default function AbandonRunControl({ onAbandon }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => { if (open) cancel.current?.focus(); }, [open]);

  const close = () => {
    setOpen(false);
    setError(null);
    trigger.current?.focus();
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const message = await onAbandon();
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setDone('Đã bỏ lượt cũ. Bạn đang làm một lượt mới từ đầu.');
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="flex flex-col items-center gap-2" data-testid="abandon-run">
      <p role="status" className={done && !open ? 'text-center text-xs text-ink-muted' : 'sr-only'}>{open ? '' : done ?? ''}</p>
      <button ref={trigger} type="button" className="btn-ghost min-h-[44px] px-3 text-sm text-ink-muted"
        aria-expanded={open} aria-controls={panelId}
        onClick={() => { if (busy) return; if (open) close(); else { setDone(null); setOpen(true); } }} data-testid="abandon-run-open">
        Bỏ lượt này
      </button>
      {open && (
        <div id={panelId} role="group" aria-labelledby={titleId} onKeyDown={onKeyDown}
          className="card flex w-full flex-col gap-3 border-warn/50 bg-warn/5" data-testid="abandon-run-confirm">
          <h2 id={titleId} className="font-semibold">Bỏ lượt này và làm lại từ đầu?</h2>
          <p className="text-sm text-ink-muted">
            Lượt đang làm sẽ dừng lại và không được chấm. Các câu trả lời của lượt này sẽ không dùng tiếp, kể cả những
            câu đã xem đáp án; bạn bắt đầu lại từ bước 1. XP và huy hiệu đã nhận vẫn giữ nguyên.
          </p>
          {error && <p role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm">{error}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button ref={cancel} type="button" className="btn-ghost" onClick={close} disabled={busy}>Làm tiếp</button>
            <button type="button" className="btn-primary" onClick={() => void confirm()} disabled={busy} aria-busy={busy}
              data-testid="abandon-run-confirm-button">
              {busy ? 'Đang bỏ lượt…' : 'Bỏ lượt và làm lại'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
