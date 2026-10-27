/**
 * Starting/resuming runs, reading them, and autosaving answers with optimistic concurrency (rev).
 * A learner has at most one open run per mission (partial unique index idx_runs_one_open_per_mission).
 */
import { getMission } from '../content/loader';
import type { Mission } from '../content/schema';
import { newId, nowIso } from '../db/ids';
import { latestEvaluationForRun } from '../db/evaluation-repository';
import { findLatestCompletedRun, findOpenRun, findRun, insertRunStatement, updateRunIfRev } from '../db/run-repository';
import { recordEventSafe } from '../observer/events';
import { recordActivityDay } from './activity';
import { answerKeyForRun, assertRevealedUnchanged } from './answer-reveals';
import { assertAnswersSize, findStep, mergeAnswers, validateStepAnswers } from './answers-validation';
import { carriedReveals } from './carried-penalties';
import { missionNotFound, RunConflictError, runNotFound } from './errors';
import { learnerMissionView, type LearnerMission } from './learner-mission-view';
import { effectiveStatus, isOpen, transition } from './mission-state-machine';
import {
  LearningError, type AnswerKey, type Answers, type Evaluation, type LearnerContext, type MissionRun, type Source,
} from './types';

export interface RunDeps {
  env: Env;
  now?: () => Date;
}

const clock = (deps: RunDeps): Date => deps.now?.() ?? new Date();

export function publishedMission(missionId: string): Mission {
  const m = getMission(missionId);
  if (!m || m.status !== 'published') throw missionNotFound();
  return m;
}

/** Loads a run owned by the learner (others' runs are not_found), with a crashed evaluation shown as failed. */
export async function loadRun(deps: RunDeps, learner: LearnerContext, runId: string): Promise<MissionRun> {
  const run = typeof runId === 'string' && runId.length <= 80 ? await findRun(deps.env.DB, learner.id, runId) : null;
  if (!run) throw runNotFound();
  return { ...run, status: effectiveStatus(run, clock(deps)) };
}

/**
 * Returns the open run of a mission, or starts a new one (the only way a new run is created). A new run after
 * "Bỏ lượt này" starts with the reveals of the abandoned runs already recorded and their answers locked
 * (carried-penalties.ts), so abandoning never turns a seen answer into a fresh one.
 */
export async function startMissionImpl(deps: RunDeps, learner: LearnerContext, missionId: string, source: Source): Promise<MissionRun> {
  const mission = publishedMission(missionId);
  const db = deps.env.DB;
  const open = await findOpenRun(db, learner.id, mission.id);
  if (open) return { ...open, status: effectiveStatus(open, clock(deps)) };
  const carried = await carriedReveals(db, learner.id, mission);
  const at = nowIso(clock(deps));
  const run: MissionRun = {
    id: newId('run'), learnerId: learner.id, missionId: mission.id, missionVersion: mission.version, status: 'started',
    currentStep: mission.steps[0]?.id ?? null, answers: carried.answers, confidence: null, hintMaxLevel: 0, hintsUsed: 0,
    revealed: carried.revealed, source, rev: 0,
    startedAt: at, updatedAt: at, completedAt: null,
  };
  try {
    await insertRunStatement(db, run).run();
  } catch (err) {
    // A concurrent start won the one-open-run-per-mission index: resume that run instead.
    const raced = await findOpenRun(db, learner.id, mission.id);
    if (raced) return { ...raced, status: effectiveStatus(raced, clock(deps)) };
    throw err;
  }
  await recordEventSafe(db, { learnerId: learner.id, name: 'mission.started', missionId: mission.id, missionVersion: mission.version, runId: run.id, source });
  return run;
}

/**
 * What opening a mission shows: the open run, else the latest completed run (its result, read-only), else a
 * new run. Re-doing a completed mission is an explicit startMissionImpl call ("Làm lại"), never implicit.
 */
export async function openMissionImpl(deps: RunDeps, learner: LearnerContext, missionId: string, source: Source): Promise<MissionRun> {
  const mission = publishedMission(missionId);
  const db = deps.env.DB;
  const open = await findOpenRun(db, learner.id, mission.id);
  if (open) return { ...open, status: effectiveStatus(open, clock(deps)) };
  const done = await findLatestCompletedRun(db, learner.id, mission.id);
  if (done) return done;
  return startMissionImpl(deps, learner, mission.id, source);
}

/** A run as the learner's client sees it: answer keys only for revealed items, or all once completed. */
export interface RunDetail {
  run: MissionRun;
  mission: LearnerMission;
  evaluation: Evaluation | null;
  answerKey: AnswerKey;
  /**
   * Revealed items ("stepId:itemId") whose locked answer came from a run abandoned earlier in this attempt,
   * so the runner can say why the answer cannot be changed. Empty once the run is closed.
   */
  carriedRevealed: string[];
}

export async function getRunDetail(deps: RunDeps, learner: LearnerContext, runId: string): Promise<RunDetail> {
  const run = await loadRun(deps, learner, runId);
  const mission = getMission(run.missionId);
  if (!mission) throw new LearningError('unavailable', 'Mission này tạm thời không khả dụng.');
  const evaluation = await latestEvaluationForRun(deps.env.DB, learner.id, run.id);
  const carried = isOpen(run.status) && run.revealed.length > 0 ? (await carriedReveals(deps.env.DB, learner.id, mission)).revealed : [];
  return {
    run, mission: learnerMissionView(mission), evaluation, answerKey: answerKeyForRun(mission, run),
    carriedRevealed: carried.filter((k) => run.revealed.includes(k)),
  };
}

/** The answer key a run's learner may see right now (e.g. returned with a submit result). */
export function runAnswerKey(run: Pick<MissionRun, 'missionId' | 'status' | 'revealed'>): AnswerKey {
  const mission = getMission(run.missionId);
  return mission ? answerKeyForRun(mission, run) : {};
}

export async function saveAnswersImpl(
  deps: RunDeps, learner: LearnerContext, runId: string,
  input: { stepId: string; answers: Answers[string]; currentStep?: string; rev: number },
): Promise<MissionRun> {
  if (!Number.isInteger(input.rev) || input.rev < 0) throw new LearningError('invalid', 'rev không hợp lệ.');
  const run = await loadRun(deps, learner, runId);
  const mission = getMission(run.missionId);
  if (!mission) throw new LearningError('unavailable', 'Mission này tạm thời không khả dụng.');
  if (input.rev !== run.rev) throw new RunConflictError(run);

  const step = findStep(mission, input.stepId);
  const clean = validateStepAnswers(step, input.answers);
  const currentStep = input.currentStep === undefined ? run.currentStep : findStep(mission, input.currentStep).id;
  const lastStepId = mission.steps[mission.steps.length - 1]?.id;
  const status = transition(run.status, { type: 'edit', reachedLastStep: currentStep === lastStepId });
  const answers = mergeAnswers(run.answers, { [step.id]: clean });
  assertAnswersSize(answers);
  assertRevealedUnchanged(mission, run, answers);

  const now = clock(deps);
  const next: MissionRun = { ...run, status, currentStep, answers, rev: run.rev + 1, updatedAt: nowIso(now) };
  if (!(await updateRunIfRev(deps.env.DB, next, run.rev))) {
    const current = await findRun(deps.env.DB, learner.id, run.id);
    if (!current) throw runNotFound();
    throw new RunConflictError({ ...current, status: effectiveStatus(current, now) });
  }
  await recordActivityDay(deps.env.DB, learner, now);
  // Moving forward past a step completes it (observer funnel; props.stepId is required there).
  const prevIndex = mission.steps.findIndex((s) => s.id === run.currentStep);
  const nextIndex = mission.steps.findIndex((s) => s.id === currentStep);
  if (prevIndex >= 0 && nextIndex > prevIndex) {
    await recordEventSafe(deps.env.DB, {
      learnerId: learner.id, name: 'mission.step_completed', missionId: mission.id, missionVersion: run.missionVersion, runId: run.id,
      source: run.source, props: { stepId: mission.steps[prevIndex].id, nextStepId: currentStep },
    });
  }
  return next;
}
