/**
 * Learning service: the single entry point for learning state. Web routes and /mcp tools call only these
 * functions, so a mission started over MCP is visible on the web and vice versa.
 *
 * Every function takes the caller's LearnerContext and must scope all reads/writes to `learner.id`
 * (cross-user access is a LearningError('forbidden'/'not_found')).
 */
import type {
  Answers, HintResult, LearnerContext, MissionListItem, MissionRun, ProgressSummary, Source, SubmitResult,
} from './types';
import { LearningError } from './types';

const todo = (name: string): never => {
  throw new LearningError('unavailable', `${name} is not implemented yet`);
};

export interface LearningDeps {
  env: Env;
  /** Clock injection for tests. */
  now?: () => Date;
}

export async function getProgress(_deps: LearningDeps, _learner: LearnerContext): Promise<ProgressSummary> {
  return todo('getProgress');
}

export async function listMissions(_deps: LearningDeps, _learner: LearnerContext): Promise<MissionListItem[]> {
  return todo('listMissions');
}

/** Starts (or resumes the open) run of a mission. Idempotent: an open run is returned instead of a new one. */
export async function startMission(
  _deps: LearningDeps, _learner: LearnerContext, _missionId: string, _source: Source,
): Promise<MissionRun> {
  return todo('startMission');
}

export async function getRun(_deps: LearningDeps, _learner: LearnerContext, _runId: string): Promise<MissionRun> {
  return todo('getRun');
}

/** Autosaves draft answers for one step. `rev` is the run's revision the client last saw (optimistic lock). */
export async function saveAnswers(
  _deps: LearningDeps, _learner: LearnerContext, _runId: string,
  _input: { stepId: string; answers: Answers[string]; currentStep?: string; rev: number },
): Promise<MissionRun> {
  return todo('saveAnswers');
}

/** Hint ladder level n (1..4). Levels unlock in order; AI failure falls back to the authored static hint. */
export async function requestHint(
  _deps: LearningDeps, _learner: LearnerContext, _runId: string, _stepId: string, _level: 1 | 2 | 3 | 4,
): Promise<HintResult> {
  return todo('requestHint');
}

/**
 * Freezes the answers as evidence, evaluates them against the rubric and grants rewards when passed.
 * Idempotent per (run, idempotencyKey). The submission is stored before any AI call, so an AI failure
 * leaves the run in 'evaluation_failed' with the evidence intact (retry re-evaluates it).
 */
export async function submitEvidence(
  _deps: LearningDeps, _learner: LearnerContext, _runId: string,
  _input: { idempotencyKey: string; answers?: Answers; confidence?: number; imageKeys?: string[]; source: Source },
): Promise<SubmitResult> {
  return todo('submitEvidence');
}
