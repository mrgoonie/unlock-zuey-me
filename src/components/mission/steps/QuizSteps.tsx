/**
 * Quiz and prediction steps. The learner answers, then taps "Kiểm tra" / "Xem đáp án" to reveal the
 * explanation; that locks the answer for that question (stored in the draft's `revealed` list).
 */
import ConfidenceSlider from '../../ui/ConfidenceSlider';
import { str, strList, type StepOf, type StepProps } from './step-props';

function Reveal({ correct, children }: { correct: boolean; children: string }) {
  return (
    <div role="status" className={`rounded-xl border p-3 text-sm ${correct ? 'border-calm/50 bg-calm/10' : 'border-warn/50 bg-warn/10'}`}>
      <p className="font-semibold">{correct ? '🎯 Chính xác!' : '🌱 Chưa đúng, không sao cả.'}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}

export function QuizStep({ step, values, onField, draft, patchDraft }: StepProps<StepOf<'quiz'>>) {
  return (
    <div className="flex flex-col gap-5">
      {step.questions.map((q) => {
        const multi = q.correct.length > 1;
        const key = `${step.id}:${q.id}`;
        const revealed = draft.revealed.includes(key);
        const picked = multi ? strList(values[q.id]) : [str(values[q.id])].filter(Boolean);
        const isCorrect = picked.length === q.correct.length && q.correct.every((c) => picked.includes(c));
        return (
          <fieldset key={q.id} className="card flex flex-col gap-2" data-testid={`quiz-${q.id}`}>
            <legend className="sr-only">{q.prompt}</legend>
            <p className="font-medium" aria-hidden="true">{q.prompt}</p>
            {multi && <p className="text-xs text-ink-muted">Chọn tất cả đáp án đúng.</p>}
            {q.options.map((o) => (
              <label key={o.id} className="choice">
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={key}
                  checked={picked.includes(o.id)}
                  disabled={revealed}
                  onChange={(e) => onField(q.id, multi
                    ? (e.target.checked ? [...picked, o.id] : picked.filter((p) => p !== o.id))
                    : o.id)}
                  className="h-5 w-5 accent-[rgb(var(--accent))]"
                />
                <span>{o.text}</span>
                {revealed && q.correct.includes(o.id) && <span className="ml-auto text-calm" aria-label="đáp án đúng">✓</span>}
              </label>
            ))}
            {revealed ? (
              <Reveal correct={isCorrect}>{q.explanation}</Reveal>
            ) : (
              <button type="button" className="btn-ghost self-start text-sm" disabled={!picked.length}
                onClick={() => patchDraft((d) => ({ ...d, revealed: [...d.revealed, key] }))}>
                Kiểm tra
              </button>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

export function PredictionStep({ step, values, onField, draft, patchDraft }: StepProps<StepOf<'prediction'>>) {
  const key = `${step.id}:prediction`;
  const revealed = draft.revealed.includes(key);
  const choice = str(values.choice);
  const confidence = typeof values.confidence === 'number' ? values.confidence : null;
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-medium">{step.question}</legend>
        {step.options.map((o) => (
          <label key={o.id} className="choice">
            <input type="radio" name={key} checked={choice === o.id} disabled={revealed}
              onChange={() => onField('choice', o.id)} className="h-5 w-5 accent-[rgb(var(--accent))]" />
            <span>{o.text}</span>
            {revealed && o.id === step.correct && <span className="ml-auto text-calm" aria-label="đáp án đúng">✓</span>}
          </label>
        ))}
      </fieldset>
      {!revealed && (
        <ConfidenceSlider label="Bạn chắc chắn bao nhiêu?" value={confidence} onChange={(v) => onField('confidence', v)} testId="prediction-confidence" />
      )}
      {revealed ? (
        <Reveal correct={choice === step.correct}>{`${step.explanation}${confidence !== null ? ` (Bạn đã chắc ${confidence}%.)` : ''}`}</Reveal>
      ) : (
        <button type="button" className="btn-ghost self-start" disabled={!choice}
          onClick={() => {
            if (confidence === null) onField('confidence', 50);
            patchDraft((d) => ({ ...d, revealed: [...d.revealed, key] }));
          }}>
          Chốt dự đoán và xem đáp án
        </button>
      )}
    </div>
  );
}
