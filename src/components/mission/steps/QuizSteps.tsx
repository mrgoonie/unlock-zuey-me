/**
 * Quiz and prediction steps. The learner answers, then taps "Kiểm tra" / "Chốt dự đoán" to reveal the
 * explanation. The reveal is recorded on the server (POST /api/v1/runs/:id/reveal), which returns the key
 * for that item only and locks the answer: the server rejects any later change to it.
 */
import { useEffect, useRef, useState } from 'react';
import type { AnswerKeyEntry } from '../../../lib/learning/types';
import ConfidenceSlider from '../../ui/ConfidenceSlider';
import { str, strList, type StepOf, type StepProps } from './step-props';

/**
 * The revealed result. After the learner's own tap the button that had focus disappears, so focus moves
 * here (`focusOnMount`) instead of dropping to <body>; a result already shown on load never steals focus.
 * Moving focus is also what makes screen readers read the new result, so the element is deliberately not a
 * live region: being both focused and live made some screen readers announce it twice. Every result that
 * appears after the learner's tap gets focus; a result already on the page at load is read in document
 * order like any other content and needs no announcement.
 */
function Reveal({ correct, focusOnMount, children }: { correct: boolean; focusOnMount: boolean; children: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <div ref={ref} tabIndex={-1}
      className={`rounded-xl border p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent ${correct ? 'border-calm/50 bg-calm/10' : 'border-warn/50 bg-warn/10'}`}>
      <p className="font-semibold">{correct ? '🎯 Chính xác!' : '🌱 Chưa đúng, không sao cả.'}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}

/** Runs one reveal request with a busy flag and an inline error; remembers which item was just revealed. */
function useReveal(onReveal: StepProps['onReveal']) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRevealed, setJustRevealed] = useState<string | null>(null);
  const reveal = async (stepId: string, itemId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const failed = await onReveal(stepId, itemId);
      setError(failed);
      if (!failed) setJustRevealed(`${stepId}:${itemId}`);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, reveal, justRevealed };
}

const isPicked = (picked: string[], key: AnswerKeyEntry): boolean =>
  picked.length === key.correct.length && key.correct.every((c) => picked.includes(c));

export function QuizStep({ step, values, onField, revealed, answerKey, onReveal }: StepProps<StepOf<'quiz'>>) {
  const { busy, error, reveal, justRevealed } = useReveal(onReveal);
  return (
    <div className="flex flex-col gap-5">
      {step.questions.map((q) => {
        const key = `${step.id}:${q.id}`;
        const entry = answerKey[key];
        const locked = revealed.includes(key);
        const picked = q.multi ? strList(values[q.id]) : [str(values[q.id])].filter(Boolean);
        return (
          <fieldset key={q.id} className="card flex flex-col gap-2" data-testid={`quiz-${q.id}`}>
            <legend className="sr-only">{q.prompt}</legend>
            <p className="font-medium" aria-hidden="true">{q.prompt}</p>
            {q.multi && <p className="text-xs text-ink-muted">Chọn tất cả đáp án đúng.</p>}
            {q.options.map((o) => (
              <label key={o.id} className="choice">
                <input
                  type={q.multi ? 'checkbox' : 'radio'}
                  name={key}
                  checked={picked.includes(o.id)}
                  disabled={locked}
                  onChange={(e) => onField(q.id, q.multi
                    ? (e.target.checked ? [...picked, o.id] : picked.filter((p) => p !== o.id))
                    : o.id)}
                  className="h-5 w-5 accent-[rgb(var(--accent))]"
                />
                <span>{o.text}</span>
                {entry?.correct.includes(o.id) && <span className="ml-auto text-calm" role="img" aria-label="đáp án đúng">✓</span>}
              </label>
            ))}
            {entry ? (
              <Reveal correct={isPicked(picked, entry)} focusOnMount={justRevealed === key}>{entry.explanation}</Reveal>
            ) : (
              <button type="button" className="btn-ghost self-start text-sm" disabled={!picked.length || busy}
                aria-busy={busy} onClick={() => void reveal(step.id, q.id)}>
                {busy ? 'Đang kiểm tra…' : 'Kiểm tra'}
              </button>
            )}
          </fieldset>
        );
      })}
      {error && <p role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm">{error}</p>}
    </div>
  );
}

export function PredictionStep({ step, values, onField, revealed, answerKey, onReveal }: StepProps<StepOf<'prediction'>>) {
  const { busy, error, reveal, justRevealed } = useReveal(onReveal);
  const key = `${step.id}:prediction`;
  const entry = answerKey[key];
  const locked = revealed.includes(key);
  const choice = str(values.choice);
  const confidence = typeof values.confidence === 'number' ? values.confidence : null;
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-medium">{step.question}</legend>
        {step.options.map((o) => (
          <label key={o.id} className="choice">
            <input type="radio" name={key} checked={choice === o.id} disabled={locked}
              onChange={() => onField('choice', o.id)} className="h-5 w-5 accent-[rgb(var(--accent))]" />
            <span>{o.text}</span>
            {entry?.correct.includes(o.id) && <span className="ml-auto text-calm" role="img" aria-label="đáp án đúng">✓</span>}
          </label>
        ))}
      </fieldset>
      {!locked && (
        <ConfidenceSlider label="Bạn chắc chắn bao nhiêu?" value={confidence} onChange={(v) => onField('confidence', v)} testId="prediction-confidence" />
      )}
      {entry ? (
        <Reveal correct={entry.correct.includes(choice)} focusOnMount={justRevealed === key}>{`${entry.explanation}${confidence !== null ? ` (Bạn đã chắc ${confidence}%.)` : ''}`}</Reveal>
      ) : (
        <button type="button" className="btn-ghost self-start" disabled={!choice || busy} aria-busy={busy}
          onClick={() => {
            if (confidence === null) onField('confidence', 50);
            void reveal(step.id, 'prediction');
          }}>
          {busy ? 'Đang chốt…' : 'Chốt dự đoán và xem đáp án'}
        </button>
      )}
      {error && <p role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm">{error}</p>}
    </div>
  );
}
