/**
 * Consent-gated learner content: evidence submissions (frozen answers + image keys) and coach/practice chat
 * transcripts. Raw learner text is only ever read here, behind consentJoin.
 */
import { parseJson } from '../db/ids';
import { consentJoin } from './consent-gate';
import type { CoachMessage, EvidenceItem } from './observer-types';

const EVIDENCE_LIMIT = 50;
const COACH_LIMIT = 500;

export async function getEvidence(db: D1Database, learnerId: string): Promise<EvidenceItem[]> {
  const rows = await db.prepare(
    `SELECT s.id, s.run_id, r.mission_id, s.answers_json, s.image_keys_json, s.created_at
     FROM evidence_submissions s JOIN mission_runs r ON r.id = s.run_id ${consentJoin('s')}
     WHERE s.learner_id = ? ORDER BY s.created_at DESC LIMIT ${EVIDENCE_LIMIT}`,
  ).bind(learnerId).all<{ id: string; run_id: string; mission_id: string; answers_json: string; image_keys_json: string; created_at: string }>();
  return rows.results.map((r) => ({
    id: r.id, runId: r.run_id, missionId: r.mission_id,
    answers: parseJson<Record<string, unknown>>(r.answers_json, {}),
    imageKeys: parseJson<unknown[]>(r.image_keys_json, []).filter((k): k is string => typeof k === 'string'),
    createdAt: r.created_at,
  }));
}

export async function getCoachTranscripts(db: D1Database, learnerId: string): Promise<CoachMessage[]> {
  const rows = await db.prepare(
    `SELECT c.id, c.run_id, c.step_id, c.channel, c.role, c.content, c.hint_level, c.created_at
     FROM coach_messages c ${consentJoin('c')} WHERE c.learner_id = ?
     ORDER BY c.created_at DESC LIMIT ${COACH_LIMIT}`,
  ).bind(learnerId).all<{
    id: string; run_id: string | null; step_id: string | null; channel: CoachMessage['channel'];
    role: CoachMessage['role']; content: string; hint_level: number | null; created_at: string;
  }>();
  // Newest 500, shown oldest first so each conversation reads top to bottom.
  return rows.results.reverse().map((r) => ({
    id: r.id, runId: r.run_id, stepId: r.step_id, channel: r.channel, role: r.role, content: r.content,
    hintLevel: r.hint_level === null ? null : Number(r.hint_level), createdAt: r.created_at,
  }));
}
