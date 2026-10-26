/**
 * Durable D1 queue of redacted turns (insight_events) feeding the ai-tutor background analyzer.
 *
 * Work is claimed per (learner, session) window with a lease: claiming stamps a random `lease_id` and
 * `lease_until = now + 5 min` and counts an attempt. Every later update is scoped `WHERE lease_id = ?`, so
 * once a lease has expired and another tick has reclaimed the rows, a stale worker's writes change nothing.
 *
 * - Ready: every pending event of the window has `next_attempt_at <= now` (ingest sets received + 5 min,
 *   the per-session debounce), or the window holds ≥ 5 fresh events. Expired leases count as pending.
 * - Window size: at most 10 events and 48 KB of payload; the overflow goes back to pending untouched.
 * - Failure: backoff 15 min × 2^(attempts-1); the 4th failed attempt moves the event to `dead`.
 * - Budget refusal: `deferWindow` gives the attempt back.
 * - Revocation: the report INSERT re-checks analysis consent inside the same statement; when it writes
 *   0 rows because consent is gone, the window's events are deleted in the same batch.
 * `payload_json` is NULLed whenever an event leaves the queue (done, skipped, dead).
 */
import { newId } from '../db/ids';
import { QUEUE_STALE_AFTER_HOURS } from './feature-flags';
import type { InsightSkipReason } from './insight-types';

export const LEASE_MS = 5 * 60_000;
export const WINDOW_MAX_EVENTS = 10;
export const WINDOW_MAX_BYTES = 48 * 1024;
/** A window with this many fresh events is ready before its debounce has passed. */
export const WINDOW_READY_COUNT = 5;
export const BACKOFF_BASE_MINUTES = 15;
/** The attempt that fails at this count moves the event to `dead`. */
export const MAX_ATTEMPTS = 4;
/** Rows touched by one stale sweep at most. */
const STALE_SWEEP_LIMIT = 500;
const LAST_ERROR_MAX_CHARS = 300;

export interface WindowKey {
  learnerId: string;
  sessionRef: string;
}

export interface QueuedEvent {
  id: string;
  learner_id: string;
  session_ref: string;
  source_runtime: string;
  payload_json: string | null;
  payload_bytes: number;
  attempts: number;
  turn_ended_at: string;
  received_at: string;
}

export interface ClaimedWindow extends WindowKey {
  leaseId: string;
  /** Kept events, ordered by turn end (≤ 10 events, ≤ 48 KB). */
  events: QueuedEvent[];
  /** Events released back to pending because the window was full. */
  released: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Analysis consent and a live learner, as a correlated SQL condition on `<alias>.learner_id`. */
const consentFor = (learnerCol: string) => `EXISTS (
  SELECT 1 FROM insight_consents c JOIN learners l ON l.id = c.learner_id
  WHERE c.learner_id = ${learnerCol} AND c.analysis = 1 AND l.deleted_at IS NULL)`;

/** Pending, or processing with an expired lease (reclaimable). `?1` must be bound to now. */
const CLAIMABLE = `(status = 'pending' OR (status = 'processing' AND lease_until < ?1))`;

/**
 * Marks events still waiting 48 h after they were received as `skipped:stale` (payload NULLed).
 * Returns the number of rows changed. One D1 query.
 */
export async function skipStaleEvents(db: D1Database, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const cutoff = iso(now.getTime() - QUEUE_STALE_AFTER_HOURS * 3_600_000);
  const r = await db.prepare(`UPDATE insight_events
      SET status = 'skipped', skip_reason = 'stale', payload_json = NULL, processed_at = ?1, lease_id = NULL, lease_until = NULL
      WHERE id IN (SELECT id FROM insight_events WHERE ${CLAIMABLE} AND received_at < ?2 LIMIT ${STALE_SWEEP_LIMIT})`)
    .bind(nowIso, cutoff).run();
  return r.meta.changes ?? 0;
}

/** Ready windows of consenting, non-deleted learners, oldest first. One D1 query. */
export async function findReadyWindows(db: D1Database, now: Date, limit: number): Promise<WindowKey[]> {
  const { results } = await db.prepare(`SELECT e.learner_id, e.session_ref, MIN(e.received_at) AS first_received
      FROM insight_events e
      WHERE (e.status = 'pending' OR (e.status = 'processing' AND e.lease_until < ?1)) AND ${consentFor('e.learner_id')}
      GROUP BY e.learner_id, e.session_ref
      HAVING MAX(e.next_attempt_at) <= ?1 OR (COUNT(*) >= ${WINDOW_READY_COUNT} AND MAX(e.attempts) = 0)
      ORDER BY first_received
      LIMIT ?2`)
    .bind(now.toISOString(), limit).all<{ learner_id: string; session_ref: string }>();
  return results.map((r) => ({ learnerId: r.learner_id, sessionRef: r.session_ref }));
}

/**
 * Leases a window's claimable events (counting one attempt each) and returns the first 10 / 48 KB of them;
 * the rest is released untouched. Events in retry backoff stay out. Returns null when nothing was claimed
 * (another worker got there first, or consent is gone). Two D1 queries, plus one more when releasing overflow.
 */
export async function claimWindow(
  db: D1Database, key: WindowKey, now: Date, leaseId: string = newId('lse'),
): Promise<ClaimedWindow | null> {
  const nowIso = now.toISOString();
  await db.prepare(`UPDATE insight_events
        SET status = 'processing', lease_id = ?2, lease_until = ?3, attempts = attempts + 1
        WHERE learner_id = ?4 AND session_ref = ?5
          AND (status = 'pending' AND (next_attempt_at <= ?1 OR attempts = 0) OR (status = 'processing' AND lease_until < ?1))
          AND ${consentFor('insight_events.learner_id')}`)
    .bind(nowIso, leaseId, iso(now.getTime() + LEASE_MS), key.learnerId, key.sessionRef).run();
  const { results: rows } = await db.prepare(`SELECT id, learner_id, session_ref, source_runtime, payload_json, payload_bytes, attempts,
        turn_ended_at, received_at
      FROM insight_events WHERE lease_id = ? ORDER BY turn_ended_at, received_at, id`).bind(leaseId).all<QueuedEvent>();
  if (rows.length === 0) return null;

  const events: QueuedEvent[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Math.max(0, row.payload_bytes);
    // Always keep the first event, even if it alone is larger than the byte cap (ingest caps it at 32 KB).
    if (events.length >= WINDOW_MAX_EVENTS || (events.length > 0 && bytes + size > WINDOW_MAX_BYTES)) break;
    events.push(row);
    bytes += size;
  }
  const overflow = rows.slice(events.length).map((r) => r.id);
  if (overflow.length) {
    await db.prepare(`UPDATE insight_events
        SET status = 'pending', lease_id = NULL, lease_until = NULL, attempts = MAX(attempts - 1, 0)
        WHERE lease_id = ? AND id IN (${overflow.map(() => '?').join(',')})`)
      .bind(leaseId, ...overflow).run();
  }
  return { ...key, leaseId, events, released: overflow.length };
}

const idList = (ids: readonly string[]) => ids.map(() => '?').join(',');

/**
 * Ends the leased events (all of them, or only `ids`) as `skipped` with `reason`, payload NULLed.
 * Returns the rows changed (0 when the lease is no longer ours).
 */
export async function skipWindow(
  db: D1Database, leaseId: string, reason: InsightSkipReason, now: Date, ids?: readonly string[],
): Promise<number> {
  if (ids && ids.length === 0) return 0;
  const r = await db.prepare(`UPDATE insight_events
      SET status = 'skipped', skip_reason = ?, payload_json = NULL, processed_at = ?, lease_id = NULL, lease_until = NULL
      WHERE lease_id = ?${ids ? ` AND id IN (${idList(ids)})` : ''}`)
    .bind(reason, now.toISOString(), leaseId, ...(ids ?? [])).run();
  return r.meta.changes ?? 0;
}

/**
 * Records a failed attempt for every leased event: backoff 15 min × 2^(attempts-1), or `dead` (payload
 * NULLed) once the event has failed MAX_ATTEMPTS times. One batch.
 */
export async function failWindow(
  db: D1Database, leaseId: string, error: unknown, now: Date,
): Promise<{ retried: number; dead: number }> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, LAST_ERROR_MAX_CHARS);
  const nowIso = now.toISOString();
  const [dead, retried] = await db.batch([
    db.prepare(`UPDATE insight_events
        SET status = 'dead', payload_json = NULL, last_error = ?, processed_at = ?, lease_id = NULL, lease_until = NULL
        WHERE lease_id = ? AND attempts >= ${MAX_ATTEMPTS}`).bind(message, nowIso, leaseId),
    db.prepare(`UPDATE insight_events
        SET status = 'pending', last_error = ?1, lease_id = NULL, lease_until = NULL,
          next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || (${BACKOFF_BASE_MINUTES} * (1 << (MAX(attempts, 1) - 1))) || ' minutes')
        WHERE lease_id = ?3`).bind(message, nowIso, leaseId),
  ]);
  return { retried: retried.meta.changes ?? 0, dead: dead.meta.changes ?? 0 };
}

/** Puts the leased events back to pending until `until` without consuming an attempt (budget refusal, quota). */
export async function deferWindow(db: D1Database, leaseId: string, until: Date): Promise<number> {
  const r = await db.prepare(`UPDATE insight_events
      SET status = 'pending', attempts = MAX(attempts - 1, 0), next_attempt_at = ?, lease_id = NULL, lease_until = NULL
      WHERE lease_id = ?`).bind(until.toISOString(), leaseId).run();
  return r.meta.changes ?? 0;
}

/** The insight_reports row written for an analysed window. */
export interface ReportRow {
  id: string;
  learnerId: string;
  sessionRef: string;
  missionId: string | null;
  runId: string | null;
  reportJson: string;
  intentSummary: string;
  skillsJson: string;
  confidence: number;
  hasProductObservation: boolean;
  sourceRuntime: string;
  model: string;
  promptVersion: number;
  eventCount: number;
  windowStartedAt: string;
  windowEndedAt: string;
  createdAt: string;
  expiresAt: string;
}

export type CompleteOutcome = 'written' | 'revoked' | 'lease_lost';

/**
 * Atomically writes the report and closes the leased events `ids` as `done` (payload NULLed). In one batch:
 * 1. INSERT … SELECT … WHERE consent still granted AND the lease is still ours;
 * 2. events → done, only if that report row exists;
 * 3. if consent is gone (no report written), the window's events are deleted;
 * then, only when nothing was written or deleted, one read of whether consent is gone or the window's events
 * no longer exist at all.
 * `revoked` covers every way the learner withdrew during the model call: consent turned off (the consent
 * write usually purges the events itself, so step 3 may find nothing left), queued turns deleted, or the
 * account deleted. `lease_lost` is only a stale worker whose events were re-leased by another one; it writes
 * nothing at all.
 */
export async function completeWindow(
  db: D1Database, leaseId: string, ids: readonly string[], row: ReportRow, now: Date,
): Promise<CompleteOutcome> {
  if (ids.length === 0) throw new Error('completeWindow needs at least one event');
  const nowIso = now.toISOString();
  const [insert, , deleted] = await db.batch([
    db.prepare(`INSERT INTO insight_reports (id, learner_id, session_ref, mission_id, run_id, report_json, intent_summary, skills_json,
          confidence, has_product_observation, source_runtime, model, prompt_version, event_count, window_started_at, window_ended_at,
          created_at, expires_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
        WHERE ${consentFor('?2')}
          AND EXISTS (SELECT 1 FROM insight_events WHERE lease_id = ?19 AND learner_id = ?2)`)
      .bind(
        row.id, row.learnerId, row.sessionRef, row.missionId, row.runId, row.reportJson, row.intentSummary, row.skillsJson,
        row.confidence, row.hasProductObservation ? 1 : 0, row.sourceRuntime, row.model, row.promptVersion, row.eventCount,
        row.windowStartedAt, row.windowEndedAt, row.createdAt, row.expiresAt, leaseId,
      ),
    db.prepare(`UPDATE insight_events
        SET status = 'done', payload_json = NULL, report_id = ?1, processed_at = ?2, lease_id = NULL, lease_until = NULL, last_error = NULL
        WHERE lease_id = ?3 AND id IN (${ids.map((_, i) => `?${i + 4}`).join(',')})
          AND EXISTS (SELECT 1 FROM insight_reports WHERE id = ?1)`)
      .bind(row.id, nowIso, leaseId, ...ids),
    db.prepare(`DELETE FROM insight_events
        WHERE lease_id = ?1 AND NOT EXISTS (SELECT 1 FROM insight_reports WHERE id = ?2)
          AND NOT ${consentFor('?3')}`)
      .bind(leaseId, row.id, row.learnerId),
  ]);
  if ((insert.meta.changes ?? 0) > 0) return 'written';
  if ((deleted.meta.changes ?? 0) > 0) return 'revoked';
  const idList = ids.map((_, i) => `?${i + 2}`).join(',');
  const check = await db.prepare(
    `SELECT (NOT ${consentFor('?1')}) OR NOT EXISTS (SELECT 1 FROM insight_events WHERE id IN (${idList})) AS withdrawn`,
  ).bind(row.learnerId, ...ids).first<{ withdrawn: number }>();
  return check?.withdrawn ? 'revoked' : 'lease_lost';
}
