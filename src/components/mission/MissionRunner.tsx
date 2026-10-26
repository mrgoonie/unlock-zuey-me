/**
 * Mission runner island (/missions/:id/run): one step per screen with progress dots, autosave, 4-level
 * hints, pre-submit self-assessment, then evaluating → needs_revision | evaluation_failed | passed.
 * A completed mission opens on its latest result (read-only) with an explicit "Làm lại".
 * `mission` is the learner-safe view (no answer keys); keys arrive from the server only when allowed.
 * Focus moves to the new screen's heading on every step/phase change.
 */
import { useEffect, useRef } from 'react';
import type { LearnerMission } from '../../lib/learning/learner-mission-view';
import { isStepComplete, STEP_KIND_LABEL } from '../../lib/ui/mission-steps';
import { EvaluatingView, EvaluationFailedView, NeedsRevisionView } from './EvaluationStates';
import HintLadder from './HintLadder';
import ResultsView from './ResultsView';
import RunnerHeader from './RunnerHeader';
import StepView from './StepView';
import SubmitReview from './SubmitReview';
import { useRunSession } from './use-run-session';

interface Props {
  missionId: string;
  mission: LearnerMission;
  /** learner.profile.sound === true (SFX are opt-in). */
  sound: boolean;
}

export default function MissionRunner({ missionId, mission: initialMission, sound }: Props) {
  const s = useRunSession(missionId, initialMission);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    heading.current?.focus();
    window.scrollTo({ top: 0 });
  }, [s.stepIndex, s.phase]);

  if (s.phase === 'loading') {
    return <p className="py-16 text-center text-ink-muted" role="status" data-testid="runner-loading">Đang mở mission…</p>;
  }
  if (s.phase === 'load_error' || !s.run || !s.draft) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center" role="alert">
        <p className="text-4xl" aria-hidden="true">🌧️</p>
        <p>{s.error ?? 'Chưa mở được mission.'}</p>
        <button type="button" className="btn-primary" onClick={() => void s.load()}>Thử lại</button>
        <a href={`/missions/${missionId}`} className="btn-ghost">Quay lại</a>
      </div>
    );
  }

  const { mission, draft, run } = s;
  const step = mission.steps[s.stepIndex];
  const completed = mission.steps.map((st) => isStepComplete(st, draft.answers));
  const isLast = s.stepIndex === mission.steps.length - 1;
  const answering = s.phase === 'steps' || s.phase === 'review';
  const header = (
    <RunnerHeader mission={mission} stepIndex={s.phase === 'review' ? mission.steps.length : s.stepIndex}
      completed={completed} saveState={s.saveState} notice={s.saveNotice} onJump={answering ? s.goToStep : undefined} />
  );

  if (s.phase === 'evaluating') return <div className="flex flex-col gap-6">{header}<EvaluatingView ref={heading} /></div>;
  if (s.phase === 'evaluation_failed') {
    return <div className="flex flex-col gap-6">{header}
      <EvaluationFailedView ref={heading} message={s.error} onRetry={() => void s.submit()} onBack={() => s.goToStep(0)} /></div>;
  }
  if (s.phase === 'needs_revision' && s.evaluation) {
    return <div className="flex flex-col gap-6">{header}<NeedsRevisionView ref={heading} mission={mission} evaluation={s.evaluation} onFix={s.goToStep} /></div>;
  }
  if (s.phase === 'passed' && s.evaluation) {
    return (
      <ResultsView ref={heading} mission={mission} evaluation={s.evaluation} rewards={s.result?.rewards ?? null}
        confidence={draft.confidence ?? run.confidence} sound={sound} replayed={s.result?.replayed ?? !s.result}
        answers={draft.answers} answerKey={s.answerKey} onAgain={s.startAgain} />
    );
  }
  if (s.phase === 'review') {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <SubmitReview ref={heading} mission={mission} answers={draft.answers} confidence={draft.confidence}
          onConfidence={(v) => s.patchDraft((d) => ({ ...d, confidence: v }))} onJump={s.goToStep}
          onSubmit={() => void s.submit()} onBack={() => s.goToStep(mission.steps.length - 1)} error={s.error}
          busy={s.submitting || s.saveState === 'saving'} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      <section key={step.id} aria-labelledby={`step-${step.id}`} className="flex flex-col gap-5" data-testid="runner-step" data-step-id={step.id}>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Bước {s.stepIndex + 1}/{mission.steps.length} · {STEP_KIND_LABEL[step.type]}
          </p>
          <h1 id={`step-${step.id}`} ref={heading} tabIndex={-1} className="text-2xl font-bold leading-snug outline-none">{step.title}</h1>
        </div>
        <StepView step={step} values={draft.answers[step.id] ?? {}} onField={(f, v) => s.updateField(step.id, f, v)}
          runId={run.id} draft={draft} patchDraft={s.patchDraft}
          revealed={run.revealed} answerKey={s.answerKey} onReveal={s.reveal} />
        <HintLadder step={step} runId={run.id} hints={draft.hints[step.id] ?? []} patchDraft={s.patchDraft} />
      </section>
      <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        {s.stepIndex > 0 && <button type="button" className="btn-ghost" onClick={() => s.goToStep(s.stepIndex - 1)} data-testid="runner-back">← Trước</button>}
        <button type="button" className="btn-primary flex-1" data-testid="runner-next"
          onClick={() => (isLast ? s.openReview() : s.goToStep(s.stepIndex + 1))}>
          {step.type === 'intro' && s.stepIndex === 0 ? 'Bắt đầu' : isLast ? 'Xem lại và nộp bài' : 'Tiếp tục'} →
        </button>
      </div>
    </div>
  );
}
