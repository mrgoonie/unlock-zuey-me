/**
 * One detective case: an AI-style answer with highlighted claims. The learner classifies claims one by
 * one and gets an explanation plus the red flags hidden in each claim.
 */
import { useState } from 'react';
import { isVerdictCorrect, RED_FLAGS, VERDICTS, type ClaimVerdict } from '../../lib/labs/detective-scoring';
import type { DetectiveCase } from '../../lib/labs/hallucination-detective-data';
import ChatBubble from './ChatBubble';
import OptionButtons from './OptionButtons';

interface Props {
  item: DetectiveCase;
  answers: Readonly<Record<string, ClaimVerdict | undefined>>;
  onAnswer: (claimId: string, verdict: ClaimVerdict) => void;
  onNext: () => void;
  isLast: boolean;
}

const verdictLabel = (v: ClaimVerdict) => {
  const found = VERDICTS.find((x) => x.id === v);
  return found ? `${found.emoji} ${found.label}` : v;
};

export default function DetectiveCaseView({ item, answers, onAnswer, onNext, isLast }: Props) {
  const [cursor, setCursor] = useState(0);
  const claim = item.claims[cursor];
  const verdict = answers[claim.id];
  const revealed = verdict !== undefined;
  const correct = revealed && isVerdictCorrect(claim, verdict);
  const lastClaim = cursor === item.claims.length - 1;

  return (
    <div>
      <div className="card space-y-2">
        <ChatBubble role="user">{item.question}</ChatBubble>
        <ChatBubble role="ai">
          {item.claims.map((c, i) => {
            const v = answers[c.id];
            const tone =
              v === undefined
                ? i === cursor
                  ? 'bg-warn/25 ring-2 ring-warn'
                  : 'bg-line/50'
                : isVerdictCorrect(c, v)
                  ? 'bg-calm/15'
                  : 'bg-danger/10';
            return (
              <span key={c.id}>
                <mark className={`rounded px-0.5 text-ink ${tone}`}>
                  <sup className="mr-0.5 font-bold">{i + 1}</sup>
                  {c.text}
                </mark>{' '}
              </span>
            );
          })}
        </ChatBubble>
      </div>

      <div className="card mt-4">
        <p className="text-sm text-ink-muted">
          Câu số {cursor + 1}/{item.claims.length}
        </p>
        <p className="mt-1 font-semibold">“{claim.text}”</p>
        <p className="mt-3 text-sm font-medium">Bạn xếp câu này vào loại nào?</p>
        <OptionButtons
          label="Phân loại câu trả lời"
          options={VERDICTS.map((v) => ({ id: v.id, label: `${v.emoji} ${v.label}`, sub: v.hint }))}
          selected={verdict}
          onSelect={(id) => onAnswer(claim.id, id as ClaimVerdict)}
          locked={revealed}
          correctIds={claim.accepted}
        />
        <div aria-live="polite">
          {revealed && (
            <div className="mt-3 text-sm">
              <p>
                <strong>{correct ? 'Thám tử giỏi! ' : `Nên chọn: ${verdictLabel(claim.accepted[0])}. `}</strong>
                {claim.explain}
              </p>
              {claim.flags.length > 0 && (
                <p className="mt-2 flex flex-wrap gap-1">
                  <span className="text-ink-muted">Dấu hiệu cần cảnh giác:</span>
                  {claim.flags.map((f) => (
                    <span key={f} className="chip">
                      <span aria-hidden="true">{RED_FLAGS[f].emoji}</span> {RED_FLAGS[f].label}
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}
        </div>
        {revealed && (
          <button
            type="button"
            className="btn-primary mt-4 w-full"
            onClick={() => (lastClaim ? onNext() : setCursor((c) => c + 1))}
          >
            {lastClaim ? (isLast ? 'Xem kết quả' : 'Vụ tiếp theo') : 'Câu tiếp theo'}
          </button>
        )}
      </div>
    </div>
  );
}
