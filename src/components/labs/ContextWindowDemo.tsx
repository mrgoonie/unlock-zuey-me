/** Part 2: a long chat on a limited "table" (context window). Old messages fall off as new ones arrive. */
import { useState } from 'react';
import { fitToWindow } from '../../lib/labs/context-window';
import { ALLERGY_MESSAGE_ID, CHECKS, DINNER_ANSWERS, WINDOW_CHAT, WINDOW_SIZES } from '../../lib/labs/context-lab-data';
import ChatBubble from './ChatBubble';
import CheckQuestion from './CheckQuestion';
import OptionButtons from './OptionButtons';

interface Props {
  onAnswered: (correct: boolean) => void;
  onNext: () => void;
}

type Size = keyof typeof WINDOW_SIZES;

export default function ContextWindowDemo({ onAnswered, onNext }: Props) {
  const [shown, setShown] = useState(2);
  const [size, setSize] = useState<Size>('small');
  const budget = WINDOW_SIZES[size];
  const fit = fitToWindow(WINDOW_CHAT.slice(0, shown), budget);
  const droppedIds = new Set(fit.dropped.map((m) => m.id));
  const complete = shown >= WINDOW_CHAT.length;
  const remembers = !droppedIds.has(ALLERGY_MESSAGE_ID);
  const pct = Math.min(100, Math.round((fit.used / budget) * 100));

  return (
    <div>
      <div className="card">
        <p className="text-sm">
          "Bàn" của AI có sức chứa giới hạn, tính bằng token (gọi là <strong>context window</strong>). Chat càng dài, tin nhắn cũ
          càng dễ rơi khỏi bàn.
        </p>
        <OptionButtons
          label="Kích thước bàn"
          options={[
            { id: 'small', label: '🪑 Bàn nhỏ', sub: `${WINDOW_SIZES.small} token` },
            { id: 'large', label: '🛋️ Bàn to', sub: `${WINDOW_SIZES.large} token` },
          ]}
          selected={size}
          onSelect={(id) => setSize(id as Size)}
        />
        <p className="mt-3 text-sm" aria-live="polite">
          Bàn đang chứa <span className="tabular-nums">{fit.used}</span>/{budget} token
          {fit.dropped.length > 0 && <> · {fit.dropped.length} tin nhắn đã rơi khỏi bàn</>}
        </p>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-line/60" aria-hidden="true">
          <div className={`h-full rounded-full transition-all duration-300 ${pct >= 90 ? 'bg-warn' : 'bg-calm'}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="card mt-4 space-y-2">
        {WINDOW_CHAT.slice(0, shown).map((m) => (
          <ChatBubble key={m.id} role={m.role} faded={droppedIds.has(m.id)}>
            {m.text}
          </ChatBubble>
        ))}
        <div aria-live="polite">
          {complete && (
            <ChatBubble role="ai">
              {remembers ? DINNER_ANSWERS.remembers : DINNER_ANSWERS.forgot}
            </ChatBubble>
          )}
        </div>
        {!complete && (
          <button type="button" className="btn-ghost w-full" onClick={() => setShown((s) => Math.min(s + 1, WINDOW_CHAT.length))}>
            💬 Gửi tin tiếp ({shown}/{WINDOW_CHAT.length})
          </button>
        )}
        {complete && (
          <p className="text-sm text-ink-muted">
            {remembers
              ? '✅ Bàn đủ rộng nên lời dặn dị ứng vẫn còn. Thử đổi sang bàn nhỏ xem sao?'
              : '😱 Lời dặn "dị ứng tôm" đã rơi khỏi bàn, nên AI quên mất! Thử đổi sang bàn to xem sao?'}
          </p>
        )}
      </div>

      {complete && <CheckQuestion {...CHECKS.window} onAnswered={onAnswered} onNext={onNext} nextLabel="Tiếp: mở chat mới" />}
    </div>
  );
}
