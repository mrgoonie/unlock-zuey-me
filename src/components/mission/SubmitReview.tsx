/**
 * Pre-submit screen: what is still missing per step (with a jump link), the self-assessment slider
 * ("Bạn tự chấm mình bao nhiêu %?") used for calibration, and the submit button.
 */
import { forwardRef, useEffect } from 'react';
import type { Mission } from '../../lib/content/schema';
import type { Answers } from '../../lib/learning/types';
import { stepGaps } from '../../lib/ui/mission-steps';
import ConfidenceSlider from '../ui/ConfidenceSlider';

interface Props {
  mission: Mission;
  answers: Answers;
  confidence: number | null;
  onConfidence: (v: number) => void;
  onJump: (i: number) => void;
  onSubmit: () => void;
  onBack: () => void;
  error: string | null;
  /** A save or submit is running: the button waits so a submit never races an autosave. */
  busy: boolean;
}

const SubmitReview = forwardRef<HTMLHeadingElement, Props>(function SubmitReview(
  { mission, answers, confidence, onConfidence, onJump, onSubmit, onBack, error, busy }, headingRef,
) {
  // The slider shows 50% before it is touched; store that value so what is shown is what gets submitted.
  useEffect(() => { if (confidence === null) onConfidence(50); }, [confidence, onConfidence]);
  const gaps = mission.steps.map((s, i) => ({ step: s, index: i, gaps: stepGaps(s, answers) })).filter((g) => g.gaps.length);
  return (
    <section className="flex flex-col gap-5" aria-labelledby="review-title" data-testid="submit-review">
      <h1 id="review-title" ref={headingRef} tabIndex={-1} className="text-2xl font-bold outline-none">Sẵn sàng nộp bài?</h1>
      {gaps.length ? (
        <div className="card flex flex-col gap-2 border-warn/50 bg-warn/5">
          <p className="font-semibold">Còn vài chỗ chưa xong. Bạn vẫn có thể nộp, nhưng điểm có thể thấp hơn:</p>
          <ul className="flex flex-col gap-1">
            {gaps.map((g) => (
              <li key={g.step.id} className="flex items-center justify-between gap-2 text-sm">
                <span>Bước {g.index + 1} · {g.gaps[0].message}</span>
                <button type="button" className="btn-ghost min-h-[44px] shrink-0 px-3 text-sm" onClick={() => onJump(g.index)}>Sửa</button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="card border-calm/40 bg-calm/5">✓ Bạn đã làm đủ các bước. Bài sẽ được chấm theo tiêu chí, kèm nhận xét cụ thể.</p>
      )}
      <div className="card">
        <ConfidenceSlider label="Bạn tự chấm mình bao nhiêu %?" value={confidence} onChange={onConfidence} testId="self-confidence" />
        <p className="mt-2 text-xs text-ink-muted">Đoán thử thôi. So sánh với điểm thật giúp bạn biết mình tự đánh giá có sát không.</p>
      </div>
      {error && <p role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <button type="button" className="btn-ghost" onClick={onBack}>← Xem lại bài</button>
        <button type="button" className="btn-primary text-lg" onClick={onSubmit} disabled={busy} aria-busy={busy} data-testid="submit-evidence">
          {busy ? 'Đang lưu bài…' : 'Nộp bằng chứng'}
        </button>
      </div>
    </section>
  );
});

export default SubmitReview;
