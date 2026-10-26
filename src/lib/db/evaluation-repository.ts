/** evidence_submissions + evaluations persistence (always scoped by learner id). */
import type { Answers, Evaluation, Rewards } from '../learning/types';
import { parseJson } from './ids';

export interface Submission {
  id: string;
  runId: string;
  learnerId: string;
  idempotencyKey: string;
  answers: Answers;
  imageKeys: string[];
  createdAt: string;
}

/** What a submission earned, stored for idempotent replays. */
export type StoredRewards = Pick<Rewards, 'xpGained' | 'newBadges'>;

interface SubmissionRow {
  id: string; run_id: string; learner_id: string; idempotency_key: string; answers_json: string; image_keys_json: string; created_at: string;
}

const toSubmission = (r: SubmissionRow): Submission => ({
  id: r.id, runId: r.run_id, learnerId: r.learner_id, idempotencyKey: r.idempotency_key,
  answers: parseJson<Answers>(r.answers_json, {}), imageKeys: parseJson<string[]>(r.image_keys_json, []), createdAt: r.created_at,
});

export async function findSubmissionByKey(db: D1Database, learnerId: string, runId: string, key: string): Promise<Submission | null> {
  const r = await db.prepare('SELECT * FROM evidence_submissions WHERE run_id = ? AND idempotency_key = ? AND learner_id = ?')
    .bind(runId, key, learnerId).first<SubmissionRow>();
  return r ? toSubmission(r) : null;
}

export async function latestSubmission(db: D1Database, learnerId: string, runId: string): Promise<Submission | null> {
  const r = await db.prepare('SELECT * FROM evidence_submissions WHERE run_id = ? AND learner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .bind(runId, learnerId).first<SubmissionRow>();
  return r ? toSubmission(r) : null;
}

/**
 * Insert that happens only while the run is still at `expected` rev/status (the claim batch in
 * submit-evidence.ts pairs it with the run update), and silently loses a race on (run_id, idempotency_key).
 */
export function insertSubmissionIfRunAtStatement(
  db: D1Database, s: Submission, source: string, expected: { rev: number; status: string },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO evidence_submissions (id, run_id, learner_id, idempotency_key, answers_json, image_keys_json, source, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM mission_runs WHERE id = ? AND learner_id = ? AND rev = ? AND status = ?)
     ON CONFLICT (run_id, idempotency_key) DO NOTHING`,
  ).bind(
    s.id, s.runId, s.learnerId, s.idempotencyKey, JSON.stringify(s.answers), JSON.stringify(s.imageKeys), source, s.createdAt,
    s.runId, s.learnerId, expected.rev, expected.status,
  );
}

interface EvaluationRow {
  id: string; run_id: string; submission_id: string; status: Evaluation['status']; score: number; criteria_json: string;
  feedback: string; strengths_json: string; improvements_json: string; mode: Evaluation['mode']; grader_model: string | null;
  created_at: string; rewards_json: string | null;
}

const toEvaluation = (r: EvaluationRow): Evaluation => ({
  id: r.id, runId: r.run_id, submissionId: r.submission_id, status: r.status, score: r.score,
  criteria: parseJson(r.criteria_json, []), feedback: r.feedback, strengths: parseJson(r.strengths_json, []),
  improvements: parseJson(r.improvements_json, []), mode: r.mode, graderModel: r.grader_model, createdAt: r.created_at,
});

/** Inserts the evaluation only while its run is still `evaluating` at the claimed `rev` (0 changes otherwise). */
export function insertEvaluationIfClaimedStatement(db: D1Database, learnerId: string, e: Evaluation, claimedRev: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO evaluations (id, run_id, submission_id, learner_id, status, score, criteria_json, feedback, strengths_json,
       improvements_json, mode, grader_model, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM mission_runs WHERE id = ? AND learner_id = ? AND status = 'evaluating' AND rev = ?)`,
  ).bind(
    e.id, e.runId, e.submissionId, learnerId, e.status, e.score, JSON.stringify(e.criteria), e.feedback,
    JSON.stringify(e.strengths), JSON.stringify(e.improvements), e.mode, e.graderModel, e.createdAt,
    e.runId, learnerId, claimedRev,
  );
}

export async function latestEvaluationForRun(db: D1Database, learnerId: string, runId: string): Promise<Evaluation | null> {
  const r = await db.prepare('SELECT * FROM evaluations WHERE run_id = ? AND learner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .bind(runId, learnerId).first<EvaluationRow>();
  return r ? toEvaluation(r) : null;
}

export async function evaluationForSubmission(
  db: D1Database, learnerId: string, submissionId: string,
): Promise<{ evaluation: Evaluation; rewards: StoredRewards } | null> {
  const r = await db.prepare('SELECT * FROM evaluations WHERE submission_id = ? AND learner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .bind(submissionId, learnerId).first<EvaluationRow>();
  if (!r) return null;
  return { evaluation: toEvaluation(r), rewards: parseJson<StoredRewards>(r.rewards_json, { xpGained: 0, newBadges: [] }) };
}

export async function saveEvaluationRewards(db: D1Database, evaluationId: string, rewards: StoredRewards): Promise<void> {
  await db.prepare('UPDATE evaluations SET rewards_json = ? WHERE id = ?').bind(JSON.stringify(rewards), evaluationId).run();
}

/** Graded (non-failed) evaluations of a learner, oldest first — used to replay competency history. */
export async function listGradedEvaluations(db: D1Database, learnerId: string): Promise<Evaluation[]> {
  const { results } = await db.prepare(
    `SELECT * FROM evaluations WHERE learner_id = ? AND status != 'failed' ORDER BY created_at ASC, rowid ASC LIMIT 2000`,
  ).bind(learnerId).all<EvaluationRow>();
  return results.map(toEvaluation);
}
