/**
 * Observer dashboard data layer. The ONLY place /admin and /api/v1/admin read learner data.
 *
 * Consent is enforced here on every call, inside each SQL statement (see consent-gate.ts):
 * - learners without observer_consent = 1 are never listed;
 * - every per-learner query returns null (→ not_found) for them, indistinguishable from an unknown id.
 * Admin authorization is the caller's job (requireObserverAdmin); consent is not.
 */
import { parseJson } from '../db/ids';
import { CONSENTED_LEARNER, consentJoin } from './consent-gate';
import { getCompetencies, getEvaluations, getFirstWin, getHintDependence, getMissionFunnel } from './learner-analytics-queries';
import { getCoachTranscripts, getEvidence } from './learner-content-queries';
import type { LearnerDetail, ObservedLearner, TimelineEvent, TimelinePage } from './observer-types';

export type * from './observer-types';

export const TIMELINE_PAGE_SIZE = 50;

const LEARNER_SELECT = `
  SELECT l.id, l.kind, l.display_name, l.created_at, l.observer_consent_at,
    COALESCE((SELECT MAX(occurred_at) FROM events WHERE learner_id = l.id), (SELECT MAX(day) FROM activity_days WHERE learner_id = l.id)) AS last_active,
    (SELECT COUNT(DISTINCT mission_id) FROM mission_runs WHERE learner_id = l.id AND status = 'completed') AS missions_done,
    (SELECT COALESCE(SUM(amount), 0) FROM xp_ledger WHERE learner_id = l.id) AS xp
  FROM learners l`;

interface LearnerRow {
  id: string; kind: 'guest' | 'member'; display_name: string | null; created_at: string;
  observer_consent_at: string | null; last_active: string | null; missions_done: number; xp: number;
}

const toLearner = (r: LearnerRow): ObservedLearner => ({
  id: r.id, kind: r.kind, displayName: r.display_name, joinedAt: r.created_at, consentAt: r.observer_consent_at,
  lastActiveAt: r.last_active, missionsDone: Number(r.missions_done), xp: Number(r.xp),
});

/** Consenting learners, most recently active first. Merged guest rows are folded into their member. */
export async function listObservedLearners(db: D1Database): Promise<ObservedLearner[]> {
  const rows = await db.prepare(`${LEARNER_SELECT} WHERE ${CONSENTED_LEARNER} AND l.merged_into IS NULL
    ORDER BY last_active IS NULL, last_active DESC LIMIT 200`).all<LearnerRow>();
  return rows.results.map(toLearner);
}

/**
 * One consenting learner, or null when the id is unknown, the learner has not consented, or it is a guest
 * row merged into a member (its data now lives under the member, governed by the member's consent).
 */
export async function getObservedLearner(db: D1Database, learnerId: string): Promise<ObservedLearner | null> {
  const row = await db.prepare(`${LEARNER_SELECT} WHERE l.id = ? AND ${CONSENTED_LEARNER} AND l.merged_into IS NULL`).bind(learnerId).first<LearnerRow>();
  return row ? toLearner(row) : null;
}

const encodeCursor = (e: { occurredAt: string; id: string }) => btoa(`${e.occurredAt}|${e.id}`);
function decodeCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = atob(cursor).split('|');
    return at && id ? { at, id } : null;
  } catch {
    return null;
  }
}

/** Newest-first event timeline page. Returns null when the learner is not observable. */
export async function getTimelinePage(
  db: D1Database, learnerId: string, opts: { cursor?: string | null; limit?: number } = {},
): Promise<TimelinePage | null> {
  if (!(await getObservedLearner(db, learnerId))) return null;
  const limit = Math.min(Math.max(opts.limit ?? TIMELINE_PAGE_SIZE, 1), 200);
  const c = decodeCursor(opts.cursor);
  const rows = await db.prepare(
    `SELECT e.id, e.name, e.mission_id, e.run_id, e.props_json, e.source, e.occurred_at
     FROM events e ${consentJoin('e')}
     WHERE e.learner_id = ? AND (? IS NULL OR e.occurred_at < ? OR (e.occurred_at = ? AND e.id < ?))
     ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?`,
  ).bind(learnerId, c?.at ?? null, c?.at ?? null, c?.at ?? null, c?.id ?? null, limit + 1)
    .all<{ id: string; name: string; mission_id: string | null; run_id: string | null; props_json: string; source: string; occurred_at: string }>();
  const events: TimelineEvent[] = rows.results.slice(0, limit).map((r) => ({
    id: r.id, name: r.name, missionId: r.mission_id, runId: r.run_id,
    props: parseJson<Record<string, unknown>>(r.props_json, {}), source: r.source, occurredAt: r.occurred_at,
  }));
  const last = events.at(-1);
  return { events, nextCursor: rows.results.length > limit && last ? encodeCursor(last) : null };
}

/** Everything the learner detail view shows, or null (→ not_found) without consent. */
export async function getLearnerDetail(db: D1Database, learnerId: string, cursor?: string | null): Promise<LearnerDetail | null> {
  const learner = await getObservedLearner(db, learnerId);
  if (!learner) return null;
  const [timeline, funnel, hints, evaluations, competencies, firstWin, evidence, coach] = await Promise.all([
    getTimelinePage(db, learnerId, { cursor }),
    getMissionFunnel(db, learnerId),
    getHintDependence(db, learnerId),
    getEvaluations(db, learnerId),
    getCompetencies(db, learnerId),
    getFirstWin(db, learnerId),
    getEvidence(db, learnerId),
    getCoachTranscripts(db, learnerId),
  ]);
  // Consent revoked between statements: treat the whole view as gone rather than show a partial one.
  if (!timeline || !firstWin) return null;
  return { learner, timeline, funnel, hints, evaluations, competencies, firstWin, evidence, coach };
}
