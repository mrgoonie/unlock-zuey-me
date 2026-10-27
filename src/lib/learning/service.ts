/**
 * Learning service: the single entry point for learning state. Web routes and /mcp tools call only these
 * functions, so a mission started over MCP is visible on the web and vice versa.
 *
 * Every function takes the caller's LearnerContext and scopes all reads/writes to `learner.id`
 * (another learner's run is LearningError('not_found'), never leaked).
 */
import { abandonRunImpl } from './abandon-run';
import { revealAnswerImpl } from './answer-reveals';
import { requestHintImpl } from './hints';
import {
  getRunDetail, loadRun, openMissionImpl, runAnswerKey, saveAnswersImpl, startMissionImpl, type RunDetail,
} from './mission-runs';
import { getProgressImpl, listMissionsImpl } from './progress';
import { submitEvidenceImpl } from './submit-evidence';
import type {
  AnswerKey, AnswerKeyEntry, Answers, HintResult, LearnerContext, MissionListItem, MissionRun, ProgressSummary, Source, SubmitResult,
} from './types';

export interface LearningDeps {
  env: Env;
  /** Clock injection for tests. */
  now?: () => Date;
  /** fetch used for OpenRouter calls (tests inject a fake). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export async function getProgress(deps: LearningDeps, learner: LearnerContext): Promise<ProgressSummary> {
  return getProgressImpl(deps, learner);
}

export async function listMissions(deps: LearningDeps, learner: LearnerContext): Promise<MissionListItem[]> {
  return listMissionsImpl(deps, learner);
}

/**
 * Starts (or resumes the open) run of a mission. Idempotent: an open run is returned instead of a new one.
 * On a completed mission this starts a new run (an explicit "do it again"); mission XP is still paid once.
 */
export async function startMission(
  deps: LearningDeps, learner: LearnerContext, missionId: string, source: Source,
): Promise<MissionRun> {
  return startMissionImpl(deps, learner, missionId, source);
}

/** Opens a mission: its open run, else its latest completed run (result, read-only), else a new run. */
export async function openMission(
  deps: LearningDeps, learner: LearnerContext, missionId: string, source: Source,
): Promise<MissionRun> {
  return openMissionImpl(deps, learner, missionId, source);
}

export async function getRun(deps: LearningDeps, learner: LearnerContext, runId: string): Promise<MissionRun> {
  return loadRun(deps, learner, runId);
}

/**
 * Run + the learner-safe mission view (no answer keys) + latest evaluation (null before the first submission)
 * + the answer keys the learner may see (revealed items, or all once the run is completed).
 */
export async function getRunWithEvaluation(deps: LearningDeps, learner: LearnerContext, runId: string): Promise<RunDetail> {
  return getRunDetail(deps, learner, runId);
}

/** Answer keys visible for a run in its current state (see getRunWithEvaluation). */
export function getRunAnswerKey(run: MissionRun): AnswerKey {
  return runAnswerKey(run);
}

/**
 * Reveals the answer of one quiz question (itemId = question id) or prediction (itemId = "prediction")
 * before submitting. Recorded on the run; the revealed answer cannot be changed afterwards.
 */
export async function revealAnswer(
  deps: LearningDeps, learner: LearnerContext, runId: string, input: { stepId: string; itemId: string },
): Promise<{ run: MissionRun; key: AnswerKeyEntry }> {
  return revealAnswerImpl(deps, learner, runId, input);
}

/** Autosaves draft answers for one step. `rev` is the run's revision the client last saw (optimistic lock). */
export async function saveAnswers(
  deps: LearningDeps, learner: LearnerContext, runId: string,
  input: { stepId: string; answers: Answers[string]; currentStep?: string; rev: number },
): Promise<MissionRun> {
  return saveAnswersImpl(deps, learner, runId, input);
}

/**
 * Abandons an open run ("Bỏ lượt này") so the learner can start the mission over. Idempotent on an abandoned
 * run; a completed run or one still being graded is `conflict`. No XP, evaluation or other side effect, and
 * no reset of penalties: the next run keeps this run's reveals locked and its hints count against the bonus.
 */
export async function abandonRun(deps: LearningDeps, learner: LearnerContext, runId: string): Promise<MissionRun> {
  return abandonRunImpl(deps, learner, runId);
}

/** Hint ladder level n (1..4). Levels unlock in order; AI failure falls back to the authored static hint. */
export async function requestHint(
  deps: LearningDeps, learner: LearnerContext, runId: string, stepId: string, level: 1 | 2 | 3 | 4,
): Promise<HintResult> {
  return requestHintImpl(deps, learner, runId, stepId, level);
}

/**
 * Freezes the answers as evidence, evaluates them against the rubric and grants rewards when passed.
 * Idempotent per (run, idempotencyKey). The submission is stored before any AI call, so an AI failure
 * leaves the run in 'evaluation_failed' with the evidence intact (retry re-evaluates it).
 */
export async function submitEvidence(
  deps: LearningDeps, learner: LearnerContext, runId: string,
  input: { idempotencyKey: string; answers?: Answers; confidence?: number; imageKeys?: string[]; source: Source },
): Promise<SubmitResult> {
  return submitEvidenceImpl(deps, learner, runId, input);
}

export { updateLearnerProfile } from './learner-profile';
export { sendPracticeChat } from './practice-chat-service';
export { recordLabResult, recordConceptView, LAB_IDS } from './labs-and-concepts';
export { getRecap } from './recap';
export { issueCertificate } from './certificates';
export { recordClientEvent, CLIENT_EVENTS } from './client-events';
export { storeEvidenceImage, readEvidence, EVIDENCE_MAX_BYTES } from './evidence-store';
export { RunConflictError } from './errors';
export type { RunDetail } from './mission-runs';
