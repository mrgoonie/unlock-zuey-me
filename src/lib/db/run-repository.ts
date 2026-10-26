/**
 * mission_runs persistence. Every read is scoped by learner id: a run owned by someone else is simply
 * "not found" so its existence never leaks.
 */
import type { Answers, MissionRun, RunStatus, Source } from '../learning/types';
import { parseJson } from './ids';

interface RunRow {
  id: string;
  learner_id: string;
  mission_id: string;
  mission_version: number;
  status: RunStatus;
  current_step: string | null;
  answers_json: string;
  confidence: number | null;
  hint_max_level: number;
  hints_used: number;
  revealed_json: string | null;
  source: Source;
  rev: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function rowToRun(r: RunRow): MissionRun {
  return {
    id: r.id,
    learnerId: r.learner_id,
    missionId: r.mission_id,
    missionVersion: r.mission_version,
    status: r.status,
    currentStep: r.current_step,
    answers: parseJson<Answers>(r.answers_json, {}),
    confidence: r.confidence,
    hintMaxLevel: r.hint_max_level,
    hintsUsed: r.hints_used,
    revealed: parseJson<string[]>(r.revealed_json ?? '[]', []),
    source: r.source,
    rev: r.rev,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

export async function findRun(db: D1Database, learnerId: string, runId: string): Promise<MissionRun | null> {
  const row = await db.prepare('SELECT * FROM mission_runs WHERE id = ? AND learner_id = ?').bind(runId, learnerId).first<RunRow>();
  return row ? rowToRun(row) : null;
}

/** The learner's most recently completed run of a mission (its result is shown read-only). */
export async function findLatestCompletedRun(db: D1Database, learnerId: string, missionId: string): Promise<MissionRun | null> {
  const row = await db.prepare(
    `SELECT * FROM mission_runs WHERE learner_id = ? AND mission_id = ? AND status = 'completed'
     ORDER BY completed_at DESC, updated_at DESC LIMIT 1`,
  ).bind(learnerId, missionId).first<RunRow>();
  return row ? rowToRun(row) : null;
}

/** The learner's open run of a mission (not completed/abandoned; a partial unique index allows at most one). */
export async function findOpenRun(db: D1Database, learnerId: string, missionId: string): Promise<MissionRun | null> {
  const row = await db.prepare(
    `SELECT * FROM mission_runs WHERE learner_id = ? AND mission_id = ? AND status NOT IN ('completed', 'abandoned')
     ORDER BY updated_at DESC LIMIT 1`,
  ).bind(learnerId, missionId).first<RunRow>();
  return row ? rowToRun(row) : null;
}

export async function listRunsByStatus(
  db: D1Database, learnerId: string, mode: 'open' | 'completed',
): Promise<MissionRun[]> {
  const where = mode === 'open' ? `status NOT IN ('completed', 'abandoned')` : `status = 'completed'`;
  const { results } = await db.prepare(
    `SELECT * FROM mission_runs WHERE learner_id = ? AND ${where} ORDER BY updated_at DESC LIMIT 200`,
  ).bind(learnerId).all<RunRow>();
  return results.map(rowToRun);
}

export function insertRunStatement(db: D1Database, run: MissionRun): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, current_step, answers_json, confidence,
       hint_max_level, hints_used, revealed_json, source, rev, started_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    run.id, run.learnerId, run.missionId, run.missionVersion, run.status, run.currentStep, JSON.stringify(run.answers),
    run.confidence, run.hintMaxLevel, run.hintsUsed, JSON.stringify(run.revealed), run.source, run.rev, run.startedAt, run.updatedAt, run.completedAt,
  );
}

/**
 * Optimistic write of answers/status: succeeds only when the stored rev still equals `expectedRev`.
 * Returns false when another writer got there first.
 */
export async function updateRunIfRev(
  db: D1Database,
  run: Pick<MissionRun, 'id' | 'learnerId' | 'status' | 'currentStep' | 'answers' | 'updatedAt'>,
  expectedRev: number,
): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE mission_runs SET status = ?, current_step = ?, answers_json = ?, rev = rev + 1, updated_at = ?
     WHERE id = ? AND learner_id = ? AND rev = ?`,
  ).bind(run.status, run.currentStep, JSON.stringify(run.answers), run.updatedAt, run.id, run.learnerId, expectedRev).run();
  return (r.meta.changes ?? 0) > 0;
}
