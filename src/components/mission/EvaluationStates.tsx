/** Non-success outcomes: grading in progress, needs revision (per-criterion fix links), grading failed. */
import { forwardRef, useEffect, useState } from 'react';
import type { LearnerMission } from '../../lib/learning/learner-mission-view';
import type { Evaluation } from '../../lib/learning/types';
import { criterionStepIndex } from '../../lib/ui/mission-steps';
import { pct } from '../../lib/ui/labels';
import CriterionRow from './CriterionRow';

const WAIT_COPY = [
  'Đang đọc bài của bạn…',
  'Đang đối chiếu từng tiêu chí…',
  'Đang viết nhận xét cho bạn…',
  'Sắp xong rồi, cảm ơn bạn đã chờ…',
];

export const EvaluatingView = forwardRef<HTMLHeadingElement>(function EvaluatingView(_props, ref) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => Math.min(n + 1, WAIT_COPY.length - 1)), 4000);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 text-center" data-testid="evaluating">
      <span aria-hidden="true" className="text-5xl motion-safe:animate-pulse">🔎</span>
      <h1 ref={ref} tabIndex={-1} className="text-2xl font-bold outline-none">Đang chấm bài</h1>
      <p className="text-ink-muted" role="status" aria-live="polite">{WAIT_COPY[i]}</p>
      <p className="max-w-xs text-sm text-ink-muted">Bài của bạn đã được lưu. Có thể mất khoảng nửa phút.</p>
    </section>
  );
});

export const NeedsRevisionView = forwardRef<HTMLHeadingElement, { mission: LearnerMission; evaluation: Evaluation; onFix: (stepIndex: number) => void }>(
  function NeedsRevisionView({ mission, evaluation, onFix }, ref) {
    const weak = evaluation.criteria.filter((c) => c.score < 0.7).sort((a, b) => a.score - b.score);
    const firstFix = weak.map((c) => criterionStepIndex(mission, c.id)).find((i) => i >= 0) ?? 0;
    return (
      <section className="flex flex-col gap-5" aria-labelledby="revise-title" data-testid="needs-revision">
        <div className="flex flex-col gap-2">
          <h1 id="revise-title" ref={ref} tabIndex={-1} className="text-2xl font-bold outline-none">Gần được rồi! Sửa thêm chút nhé 💪</h1>
          <p className="text-ink-muted" aria-live="polite">
            Bài đạt {pct(evaluation.score)}%, cần {pct(mission.rubric.pass_score)}% để hoàn thành. Bài làm của bạn vẫn còn nguyên, chỉ cần sửa vài chỗ.
          </p>
        </div>
        {evaluation.feedback && <p className="card">{evaluation.feedback}</p>}
        <ul className="flex flex-col gap-3">
          {evaluation.criteria.map((c) => {
            const idx = criterionStepIndex(mission, c.id);
            return (
              <li key={c.id}>
                <CriterionRow criterion={c} action={c.score < 0.7 && idx >= 0
                  ? { label: `Sửa bước ${idx + 1}`, onClick: () => onFix(idx) } : undefined} />
              </li>
            );
          })}
        </ul>
        {evaluation.improvements.length > 0 && (
          <div className="card">
            <h2 className="mb-2 font-semibold">Gợi ý để sửa</h2>
            <ul className="list-disc space-y-1 pl-5">{evaluation.improvements.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
        )}
        <button type="button" className="btn-primary" onClick={() => onFix(firstFix)} data-testid="revise-start">Bắt đầu sửa</button>
      </section>
    );
  },
);

export const EvaluationFailedView = forwardRef<HTMLHeadingElement, { message: string | null; onRetry: () => void; onBack: () => void }>(
  function EvaluationFailedView({ message, onRetry, onBack }, ref) {
    return (
      <section className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 text-center" data-testid="evaluation-failed">
        <span aria-hidden="true" className="text-5xl">🫶</span>
        <h1 ref={ref} tabIndex={-1} className="text-2xl font-bold outline-none">Bài của bạn đã được lưu</h1>
        <p className="max-w-sm text-ink-muted" role="alert">
          Việc chấm bài đang gặp trục trặc, không phải lỗi của bạn. {message ?? ''}
        </p>
        <button type="button" className="btn-primary" onClick={onRetry} data-testid="retry-submit">Thử chấm lại</button>
        <button type="button" className="btn-ghost" onClick={onBack}>Xem lại bài làm</button>
      </section>
    );
  },
);
