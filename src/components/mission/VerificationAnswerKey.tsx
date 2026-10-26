/**
 * After passing: reference verdicts + explanations for each verification claim next to the learner's
 * choice. Only rendered on the passed screen so the key never leaks before grading.
 */
import type { Mission } from '../../lib/content/schema';
import { VERDICTS } from './steps/VerificationStep';

const verdictLabel = (id: unknown) => VERDICTS.find((v) => v.id === id);

export default function VerificationAnswerKey({ mission, answers }: { mission: Mission; answers: Record<string, Record<string, unknown>> }) {
  const steps = mission.steps.filter((s) => s.type === 'verification');
  if (!steps.length) return null;
  return (
    <details className="card group">
      <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold">🔎 Xem đáp án phần kiểm chứng</summary>
      <ul className="mt-3 flex flex-col gap-3">
        {steps.flatMap((s) => s.claims.map((c) => {
          const mine = verdictLabel(answers[s.id]?.[c.id]);
          const ref = verdictLabel(c.answer);
          const same = mine?.id === ref?.id;
          return (
            <li key={`${s.id}-${c.id}`} className="flex flex-col gap-1 border-t border-line pt-3 first:border-0 first:pt-0">
              <p className="font-medium">“{c.text}”</p>
              <p className="text-sm">
                Đáp án: <strong>{ref?.emoji} {ref?.label}</strong>
                {mine && <span className={same ? 'text-calm' : 'text-warn'}> · Bạn chọn: {mine.label}{same ? ' ✓' : ''}</span>}
              </p>
              <p className="text-sm text-ink-muted">{c.explanation}</p>
            </li>
          );
        }))}
      </ul>
    </details>
  );
}
