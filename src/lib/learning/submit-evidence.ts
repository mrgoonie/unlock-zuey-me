/**
 * Evidence submission. Order matters for safety:
 *   1. an already-seen (run, idempotencyKey) replays the stored result and grants nothing;
 *   2. the run is claimed (status → evaluating) with an optimistic rev check, so concurrent submits cannot
 *      both evaluate;
 *   3. the submission is stored BEFORE any AI call, so an AI outage never loses evidence;
 *   4. evaluation + rewards are persisted by finalizeEvaluation.
 * Retrying an evaluation_failed run with a new key re-evaluates the latest stored submission unless the
 * learner edited answers since (which moves the run back to started).
 */
import { getMission } from '../content/loader';
import { AiUnavailableError, type AiDeps } from '../coach/ai-gateway';
import { newId, nowIso } from '../db/ids';
import {
  evaluationForSubmission, findSubmissionByKey, insertSubmissionStatement, latestSubmission, type Submission,
} from '../db/evaluation-repository';
import { sumXp } from '../db/progress-queries';
import { findRun } from '../db/run-repository';
import { recordEventSafe } from '../observer/events';
import { loadStreak, recordActivityDay } from './activity';
import { assertAnswersSize, mergeAnswers, validateAnswersDoc } from './answers-validation';
import { RunConflictError, runNotFound } from './errors';
import { evaluateAnswers, failedEvaluationDraft, type EvaluationDraft } from './evaluate-submission';
import { assertOwnedEvidenceKeys } from './evidence-store';
import { finalizeEvaluation } from './finalize-evaluation';
import { effectiveStatus, transition } from './mission-state-machine';
import { LearningError, type Answers, type LearnerContext, type MissionRun, type Source, type SubmitResult } from './types';
import { levelForXp } from './xp-and-levels';

export interface SubmitInput {
  idempotencyKey: string;
  answers?: Answers;
  confidence?: number;
  imageKeys?: string[];
  source: Source;
}

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

function validateInput(input: SubmitInput): void {
  if (!KEY_RE.test(input.idempotencyKey)) throw new LearningError('invalid', 'idempotencyKey không hợp lệ (8–128 ký tự chữ, số, _ . : -).');
  if (input.confidence !== undefined && (!Number.isInteger(input.confidence) || input.confidence < 0 || input.confidence > 100)) {
    throw new LearningError('invalid', 'Độ tự tin phải là số nguyên từ 0 đến 100.');
  }
  if (input.imageKeys && (!Array.isArray(input.imageKeys) || input.imageKeys.some((k) => typeof k !== 'string'))) {
    throw new LearningError('invalid', 'imageKeys phải là danh sách chuỗi.');
  }
}

const hasAnyAnswer = (a: Answers): boolean =>
  Object.values(a).some((step) => Object.values(step).some((v) => (Array.isArray(v) ? v.some((x) => x.trim()) : typeof v === 'number' || v.trim() !== '')));

async function replay(env: Env, learner: LearnerContext, run: MissionRun, sub: Submission, now: Date): Promise<SubmitResult> {
  const stored = await evaluationForSubmission(env.DB, learner.id, sub.id);
  if (!stored) throw new LearningError('conflict', 'Bài nộp này đang được chấm. Vui lòng đợi một chút rồi tải lại.');
  const [xpTotal, streak] = await Promise.all([sumXp(env.DB, learner.id), loadStreak(env.DB, learner, now)]);
  return {
    run, evaluation: stored.evaluation, replayed: true,
    rewards: { ...stored.rewards, xpTotal, level: levelForXp(xpTotal), streak },
  };
}

export async function submitEvidenceImpl(
  deps: AiDeps, learner: LearnerContext, runId: string, input: SubmitInput,
): Promise<SubmitResult> {
  validateInput(input);
  const { env } = deps;
  const db = env.DB;
  const now = deps.now?.() ?? new Date();
  const run = await findRun(db, learner.id, runId);
  if (!run) throw runNotFound();

  const seen = await findSubmissionByKey(db, learner.id, run.id, input.idempotencyKey);
  if (seen) return replay(env, learner, run, seen, now);

  const mission = getMission(run.missionId);
  if (!mission) throw new LearningError('unavailable', 'Mission này tạm thời không khả dụng.');
  const status = effectiveStatus(run, now);
  transition(status, { type: 'submit' });

  // Choose the evidence to freeze.
  const previous = status === 'evaluation_failed' && !input.answers ? await latestSubmission(db, learner.id, run.id) : null;
  const answers = previous ? previous.answers : input.answers ? mergeAnswers(run.answers, validateAnswersDoc(mission, input.answers)) : run.answers;
  const imageKeys = [...new Set(input.imageKeys ?? previous?.imageKeys ?? [])];
  assertAnswersSize(answers);
  if (!hasAnyAnswer(answers)) throw new LearningError('invalid', 'Bạn chưa có câu trả lời nào để nộp.');
  await assertOwnedEvidenceKeys(env, learner.id, imageKeys);

  // Claim the run (optimistic): only one submit can move it to evaluating.
  const at = nowIso(now);
  const claim = await db.prepare(
    `UPDATE mission_runs SET status = 'evaluating', answers_json = ?, confidence = COALESCE(?, confidence), rev = rev + 1, updated_at = ?
     WHERE id = ? AND learner_id = ? AND rev = ? AND status = ?`,
  ).bind(JSON.stringify(answers), input.confidence ?? null, at, run.id, learner.id, run.rev, run.status).run();
  if ((claim.meta.changes ?? 0) === 0) {
    const raced = await findSubmissionByKey(db, learner.id, run.id, input.idempotencyKey);
    const current = await findRun(db, learner.id, run.id);
    if (raced && current) return replay(env, learner, current, raced, now);
    if (current) throw new RunConflictError(current, 'Bài làm vừa thay đổi hoặc đang được chấm. Hãy tải lại rồi nộp lần nữa.');
    throw runNotFound();
  }

  const submission: Submission = {
    id: newId('sub'), runId: run.id, learnerId: learner.id, idempotencyKey: input.idempotencyKey, answers, imageKeys, createdAt: at,
  };
  await insertSubmissionStatement(db, submission, input.source).run();
  const ev = { learnerId: learner.id, runId: run.id, missionId: mission.id, missionVersion: run.missionVersion, source: input.source };
  await recordEventSafe(db, { ...ev, name: 'evidence.submitted', props: { submissionId: submission.id, images: imageKeys.length, retry: !!previous } });
  await recordActivityDay(db, learner, now);

  let draft: EvaluationDraft;
  try {
    draft = await evaluateAnswers(deps, { learnerId: learner.id, runId: run.id, mission, answers, imageCount: imageKeys.length });
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) console.error('evaluation crashed', err);
    draft = failedEvaluationDraft(mission, answers);
  }
  const claimed: MissionRun = { ...run, confidence: input.confidence ?? run.confidence, status: 'evaluating' };
  const result = await finalizeEvaluation(env, { learner, run: claimed, mission, submissionId: submission.id, draft, source: input.source, now });
  return { ...result, replayed: false };
}
