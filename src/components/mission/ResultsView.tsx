/**
 * Passed results: total %, per-criterion bars + feedback, strengths/improvements, calibration, XP count-up,
 * new badges, level-up, confetti/SFX (respecting reduced motion and the sound setting) and next-step CTAs.
 * Also the read-only view of a completed mission reopened later, with an explicit "Làm lại" (new run).
 */
import { forwardRef, useEffect, useRef, useState } from 'react';
import type { LearnerMission } from '../../lib/learning/learner-mission-view';
import type { AnswerKey, Evaluation, Rewards } from '../../lib/learning/types';
import { fireConfetti } from '../../lib/ui/confetti';
import { pct } from '../../lib/ui/labels';
import { calibration, didLevelUp } from '../../lib/ui/results-helpers';
import { playSound } from '../../lib/ui/sfx';
import CountUp from '../ui/CountUp';
import CriterionRow from './CriterionRow';
import ResultsNextSteps from './ResultsNextSteps';
import VerificationAnswerKey from './VerificationAnswerKey';

interface Props {
  mission: LearnerMission;
  evaluation: Evaluation;
  rewards: Rewards | null;
  confidence: number | null;
  sound: boolean;
  replayed: boolean;
  answers: Record<string, Record<string, unknown>>;
  answerKey: AnswerKey;
  /** Starts a new run of this mission. Resolves to an error message, or null. */
  onAgain: () => Promise<string | null>;
}

const ResultsView = forwardRef<HTMLHeadingElement, Props>(function ResultsView(
  { mission, evaluation, rewards, confidence, sound, replayed, answers, answerKey, onAgain }, ref,
) {
  const celebrated = useRef(false);
  const [againBusy, setAgainBusy] = useState(false);
  const [againError, setAgainError] = useState<string | null>(null);
  const again = async () => {
    if (againBusy) return;
    setAgainBusy(true);
    setAgainError(null);
    const err = await onAgain();
    // On success the runner switches to the new run and unmounts this view.
    if (err) {
      setAgainError(err);
      setAgainBusy(false);
    }
  };
  const cal = calibration(confidence, evaluation.score);
  const levelUp = didLevelUp(rewards);

  useEffect(() => {
    if (celebrated.current || replayed) return;
    celebrated.current = true;
    fireConfetti();
    playSound('success', sound);
    if (rewards?.newBadges.length) setTimeout(() => playSound('badge', sound), 700);
  }, [replayed, rewards, sound]);

  return (
    <section className="flex flex-col gap-5" aria-labelledby="result-title" data-testid="results">
      <header className="card flex flex-col items-center gap-2 border-calm/40 bg-calm/5 text-center">
        <span aria-hidden="true" className="text-5xl">🎉</span>
        <h1 id="result-title" ref={ref} tabIndex={-1} className="text-2xl font-bold outline-none">
          Đạt <span data-testid="result-score">{pct(evaluation.score)}%</span> · Mission hoàn thành ✅
        </h1>
        {evaluation.feedback && <p className="text-ink-muted">{evaluation.feedback}</p>}
        {replayed && <p className="text-xs text-ink-muted">Kết quả này đã được ghi nhận trước đó, phần thưởng không bị cộng hai lần.</p>}
      </header>

      {rewards && (
        <div className="grid grid-cols-2 gap-3" aria-live="polite">
          <div className="card flex flex-col items-center gap-1 text-center" data-testid="xp-gained">
            <p className="text-3xl font-bold text-accent"><CountUp to={rewards.xpGained} prefix="+" suffix=" XP" /></p>
            <p className="text-xs text-ink-muted">Tổng {rewards.xpTotal} XP</p>
            {rewards.xpGained === 0 && !replayed && (
              <p className="text-xs text-ink-muted" data-testid="xp-already-earned">XP của mission này đã được cộng ở lần hoàn thành đầu tiên.</p>
            )}
          </div>
          <div className="card flex flex-col items-center gap-1 text-center" data-testid="level-info">
            <p className="text-lg font-bold">{levelUp ? '⬆️ Lên cấp!' : `Cấp ${rewards.level.id}`}</p>
            <p className="text-xs text-ink-muted">{rewards.level.id} · {rewards.level.name}</p>
          </div>
        </div>
      )}

      {rewards && rewards.newBadges.length > 0 && (
        <div className="card flex flex-col gap-2" aria-live="polite">
          <h2 className="font-semibold">Huy hiệu mới</h2>
          <ul className="flex flex-wrap gap-2">
            {rewards.newBadges.map((b) => (
              <li key={b.id} className="chip min-h-[40px] px-3 text-sm motion-safe:animate-bounce [animation-iteration-count:2]" data-testid={`badge-${b.id}`}>
                <span aria-hidden="true">{b.emoji}</span> {b.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      {cal && (
        <p className="card text-sm" data-testid="calibration">
          🎯 Bạn tự chấm <strong>{cal.guessed}%</strong>, kết quả thật <strong>{cal.actual}%</strong>. {cal.message}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="font-semibold">Điểm theo từng tiêu chí</h2>
        <ul className="flex flex-col gap-3">
          {evaluation.criteria.map((c) => <li key={c.id}><CriterionRow criterion={c} /></li>)}
        </ul>
      </div>

      {(evaluation.strengths.length > 0 || evaluation.improvements.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {evaluation.strengths.length > 0 && (
            <div className="card"><h2 className="mb-2 font-semibold">💪 Điểm mạnh</h2>
              <ul className="list-disc space-y-1 pl-5 text-sm">{evaluation.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
          )}
          {evaluation.improvements.length > 0 && (
            <div className="card"><h2 className="mb-2 font-semibold">🌱 Lần sau thử</h2>
              <ul className="list-disc space-y-1 pl-5 text-sm">{evaluation.improvements.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
          )}
        </div>
      )}

      <VerificationAnswerKey mission={mission} answers={answers} answerKey={answerKey} />
      <ResultsNextSteps mission={mission} score={evaluation.score} />

      <div className="card flex flex-col gap-2">
        <p className="text-sm text-ink-muted">Muốn luyện thêm? Làm lại sẽ mở một lượt mới. XP chỉ được cộng ở lần hoàn thành đầu tiên.</p>
        <button type="button" className="btn-ghost" onClick={() => void again()} disabled={againBusy} aria-busy={againBusy} data-testid="mission-again">
          {againBusy ? 'Đang mở lượt mới…' : '🔁 Làm lại'}
        </button>
        {againError && <p role="alert" className="text-sm text-danger">{againError}</p>}
      </div>
    </section>
  );
});

export default ResultsView;
