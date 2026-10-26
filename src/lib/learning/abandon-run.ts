/**
 * Learner-initiated abandon of an open mission run ("Bỏ lượt này").
 *
 * The run moves to `abandoned` (terminal), which frees the one-open-run-per-mission slot
 * (idx_runs_one_open_per_mission) so the next start creates a fresh run. Nothing else changes: no XP,
 * no evaluation, answers and reveals stay on the abandoned row for the learner's history and export.
 * Idempotent: abandoning an already-abandoned run returns it unchanged. A completed run cannot be
 * abandoned, and neither can a run whose evaluation is still running (the grade would be thrown away);
 * a crashed evaluation (shown as evaluation_failed) can.
 */
import { nowIso } from '../db/ids';
import { findRun } from '../db/run-repository';
import { recordEventSafe } from '../observer/events';
import { runNotFound } from './errors';
import { effectiveStatus, transition } from './mission-state-machine';
import { loadRun, type RunDeps } from './mission-runs';
import { LearningError, type LearnerContext, type MissionRun } from './types';

/** Concurrent writers (autosave in another tab) can bump `rev` between the read and the write. */
const MAX_ATTEMPTS = 3;

export async function abandonRunImpl(deps: RunDeps, learner: LearnerContext, runId: string): Promise<MissionRun> {
  let run = await loadRun(deps, learner, runId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (run.status === 'abandoned') return run;
    if (run.status === 'evaluating') {
      throw new LearningError('conflict', 'Bài làm đang được chấm. Đợi có kết quả rồi hãy quyết định bỏ lượt nhé.');
    }
    // completed → conflict ("Mission này đã hoàn thành."); every other open status → abandoned.
    const status = transition(run.status, { type: 'abandon' });
    const now = deps.now?.() ?? new Date();
    const updatedAt = nowIso(now);
    // Guarded on the rev we read: a crashed `evaluating` row (effective evaluation_failed) is matched by rev,
    // and a late finalize of that evaluation is then a no-op (it requires status = 'evaluating' at its rev).
    const res = await deps.env.DB.prepare(
      `UPDATE mission_runs SET status = ?, rev = rev + 1, updated_at = ?
       WHERE id = ? AND learner_id = ? AND rev = ? AND status NOT IN ('completed', 'abandoned')`,
    ).bind(status, updatedAt, run.id, learner.id, run.rev).run();
    if ((res.meta.changes ?? 0) > 0) {
      await recordEventSafe(deps.env.DB, {
        learnerId: learner.id, name: 'mission.abandoned', missionId: run.missionId, missionVersion: run.missionVersion,
        runId: run.id, source: run.source, props: { stepId: run.currentStep },
      });
      return { ...run, status, rev: run.rev + 1, updatedAt };
    }
    const current = await findRun(deps.env.DB, learner.id, run.id);
    if (!current) throw runNotFound();
    run = { ...current, status: effectiveStatus(current, now) };
  }
  throw new LearningError('conflict', 'Bài làm vừa được cập nhật ở nơi khác. Bạn thử lại nhé.');
}
