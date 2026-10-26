/** Part 1: toggle context cards on the "table" and watch the fake AI's plan change. */
import { useState } from 'react';
import { contextKey, pickVariant } from '../../lib/labs/context-window';
import { CARD_ORDER, CHECKS, CONTEXT_CARDS, PLAN_QUESTION, PLAN_VARIANTS } from '../../lib/labs/context-lab-data';
import ChatBubble from './ChatBubble';
import CheckQuestion from './CheckQuestion';

interface Props {
  onAnswered: (correct: boolean) => void;
  onNext: () => void;
}

export default function ContextCardsChat({ onAnswered, onNext }: Props) {
  const [active, setActive] = useState<string[]>([]);
  const [tried, setTried] = useState<Set<string>>(() => new Set(['']));
  const answer = pickVariant(PLAN_VARIANTS, active, CARD_ORDER);
  const activeCards = CONTEXT_CARDS.filter((c) => active.includes(c.id));
  const canCheck = tried.size >= 3;

  const toggle = (id: string) => {
    const next = active.includes(id) ? active.filter((a) => a !== id) : [...active, id];
    setActive(next);
    setTried((prev) => new Set(prev).add(contextKey(next, CARD_ORDER)));
  };

  return (
    <div>
      <div className="card">
        <p className="text-sm">
          Bấm để đặt <strong>thẻ ngữ cảnh</strong> lên bàn của AI (hoặc cất đi). Câu hỏi giữ nguyên, chỉ ngữ cảnh thay đổi.
        </p>
        <div className="mt-3 grid gap-2" role="group" aria-label="Thẻ ngữ cảnh">
          {CONTEXT_CARDS.map((c) => {
            const on = active.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(c.id)}
                className={`min-h-[44px] rounded-xl border-2 px-3 py-2 text-left transition ${
                  on ? 'border-calm bg-calm/10' : 'border-dashed border-line bg-surface hover:bg-line/40'
                }`}
              >
                <span className="font-semibold">
                  <span aria-hidden="true">{c.emoji}</span> {c.label} {on ? '· trên bàn' : '· bấm để thêm'}
                </span>
                <span className="block text-sm text-ink-muted">{c.text}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card mt-4 space-y-2">
        <p className="text-xs font-medium text-ink-muted">Cuộc trò chuyện</p>
        {activeCards.length > 0 && (
          <ChatBubble role="user">
            {activeCards.map((c) => c.text).join(' ')}
          </ChatBubble>
        )}
        <ChatBubble role="user">{PLAN_QUESTION}</ChatBubble>
        <div aria-live="polite">
          <ChatBubble role="ai">{answer}</ChatBubble>
        </div>
        <p className="text-xs text-ink-muted">
          {canCheck ? 'Thử thêm vài kiểu nữa, hoặc trả lời câu hỏi bên dưới.' : `Thử ít nhất 3 kiểu bàn khác nhau (${tried.size}/3).`}
        </p>
      </div>

      {canCheck && <CheckQuestion {...CHECKS.plan} onAnswered={onAnswered} onNext={onNext} nextLabel="Tiếp: bàn đầy thì sao?" />}
    </div>
  );
}
