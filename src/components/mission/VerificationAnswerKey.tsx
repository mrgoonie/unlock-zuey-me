/**
 * After passing: reference verdicts + explanations for each verification claim next to the learner's
 * choice. The keys come from the server only once the run is completed (`answerKey`), so they never reach
 * the browser before grading.
 */
import type { LearnerMission } from '../../lib/learning/learner-mission-view';
import type { AnswerKey } from '../../lib/learning/types';
import { VERDICTS } from './steps/VerificationStep';

const verdictLabel = (id: unknown) => VERDICTS.find((v) => v.id === id);

export default function VerificationAnswerKey({ mission, answers, answerKey }: {
  mission: LearnerMission; answers: Record<string, Record<string, unknown>>; answerKey: AnswerKey;
}) {
  const items = mission.steps.flatMap((s) => (s.type === 'verification'
    ? s.claims.flatMap((c) => {
      const entry = answerKey[`${s.id}:${c.id}`];
      return entry ? [{ stepId: s.id, claim: c, entry }] : [];
    })
    : []));
  if (!items.length) return null;
  return (
    <details className="card group">
      <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold">🔎 Xem đáp án phần kiểm chứng</summary>
      <ul className="mt-3 flex flex-col gap-3">
        {items.map(({ stepId, claim, entry }) => {
          const mine = verdictLabel(answers[stepId]?.[claim.id]);
          const ref = verdictLabel(entry.correct[0]);
          const same = mine?.id === ref?.id;
          return (
            <li key={`${stepId}-${claim.id}`} className="flex flex-col gap-1 border-t border-line pt-3 first:border-0 first:pt-0">
              <p className="font-medium">“{claim.text}”</p>
              <p className="text-sm">
                Đáp án: <strong>{ref?.emoji} {ref?.label}</strong>
                {mine && <span className={same ? 'text-calm' : 'text-warn'}> · Bạn chọn: {mine.label}{same ? ' ✓' : ''}</span>}
              </p>
              <p className="text-sm text-ink-muted">{entry.explanation}</p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
