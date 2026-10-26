/**
 * In-app practice chat (POST /api/v1/coach/chat) in a native <dialog> bottom sheet: focus is trapped by the
 * browser, Esc closes it. The learner can move any AI reply into the step's answer box with one tap.
 * Messages live only in this component; the daily cap and errors are explained in plain words.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, friendlyMessage, type ChatMessage } from '../../../lib/ui/api-client';

interface Props {
  open: boolean;
  onClose: () => void;
  runId: string;
  stepId: string;
  suggestions: string[];
  onUseReply: (reply: string) => void;
}

export default function PracticeChatDrawer({ open, onClose, runId, stepId, suggestions, onUseReply }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [usedIndex, setUsedIndex] = useState<number | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      requestAnimationFrame(() => input.current?.focus());
    } else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, busy]);

  async function send() {
    const content = text.trim();
    if (!content || busy) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setText('');
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.coachChat({ runId, stepId, messages: next.slice(-12) });
      setMessages([...next, { role: 'assistant', content: res.reply }]);
      setRemaining(res.remainingToday);
    } catch (e) {
      const budget = e instanceof ApiError && (e.code === 'budget_exceeded' || e.code === 'rate_limited');
      setNotice(budget
        ? 'Hôm nay đã hết lượt chat trong app. Hãy bấm “Mở ChatGPT” để làm tiếp, kết quả vẫn được tính như nhau.'
        : `${friendlyMessage(e)} Tin nhắn của bạn vẫn ở đây, bấm Gửi lại khi sẵn sàng.`);
      setText(content);
      setMessages(messages);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby={`${stepId}-chat-title`}
      className="m-0 mt-auto h-[85dvh] w-full max-w-none rounded-t-3xl border border-line bg-surface p-0 text-ink backdrop:bg-black/40 sm:mx-auto sm:max-w-2xl"
      data-testid="practice-chat"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h2 id={`${stepId}-chat-title`} className="font-semibold">💬 Chat luyện tập</h2>
            <p className="text-xs text-ink-muted">{remaining !== null ? `Còn ${remaining} lượt hôm nay` : 'Có giới hạn lượt mỗi ngày'}</p>
          </div>
          <button type="button" className="btn-ghost min-w-[44px] px-3" onClick={onClose} aria-label="Đóng chat">✕</button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
          {messages.length === 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-ink-muted">Bắt đầu bằng một câu gợi ý (sửa phần trong ngoặc vuông):</p>
              {suggestions.map((s, i) => (
                <button key={i} type="button" className="card text-left text-sm hover:border-accent" onClick={() => { setText(s); input.current?.focus(); }}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <ul className="flex flex-col gap-3">
            {messages.map((m, i) => (
              <li key={i} className={m.role === 'user' ? 'self-end max-w-[85%]' : 'self-start max-w-[92%]'}>
                <p className="sr-only">{m.role === 'user' ? 'Bạn:' : 'AI:'}</p>
                <div className={`whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-accent text-accent-ink' : 'border border-line bg-bg'}`}>
                  {m.content}
                </div>
                {m.role === 'assistant' && (
                  <button type="button" className="mt-1 min-h-[44px] text-sm font-semibold text-accent"
                    onClick={() => { onUseReply(m.content); setUsedIndex(i); }}>
                    {usedIndex === i ? '✓ Đã dán vào ô trả lời' : '⬇ Dán câu trả lời này vào bài'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {busy && <p className="mt-3 text-sm text-ink-muted" role="status">AI đang trả lời…</p>}
          {notice && <p className="mt-3 rounded-xl border border-warn/50 bg-warn/10 p-3 text-sm" role="alert">{notice}</p>}
          <div ref={endRef} />
        </div>

        <form className="flex items-end gap-2 border-t border-line p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]"
          onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label htmlFor={`${stepId}-chat-input`} className="sr-only">Tin nhắn cho AI</label>
          <textarea id={`${stepId}-chat-input`} ref={input} rows={2} className="field resize-none" value={text}
            placeholder="Nhập tin nhắn…" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <button type="submit" className="btn-primary shrink-0" disabled={busy || !text.trim()}>Gửi</button>
        </form>
      </div>
    </dialog>
  );
}
