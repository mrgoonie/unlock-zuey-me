/**
 * Cron cleanup of abandoned guest learners. Every cookie-less browser visit creates a guest, so guests that
 * never came back would pile up forever. A guest is removed (rows + evidence images, through the same
 * erasure path as "xoá dữ liệu của tôi") when it has not been seen for a while:
 * - no mission or lab run at all and inactive for GUEST_NO_RUNS_DAYS, or
 * - no progress (no XP, badge or recent run) and inactive for GUEST_NO_PROGRESS_DAYS.
 * Guests merged into a member, guests holding a certificate and guests with any progress are never removed.
 * "Inactive" means created before the cutoff and no session seen since then (sessions refresh daily).
 */
import { deleteLearnerData } from '../privacy/delete-learner-data';

export const GUEST_NO_RUNS_DAYS = 7;
export const GUEST_NO_PROGRESS_DAYS = 30;
/** Guests removed per cron run (each removal is a handful of D1/R2 subrequests). */
export const GUEST_CLEANUP_BATCH = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GuestCleanupResult {
  removed: number;
  failed: number;
}

/** Ids of guests that qualify for removal, oldest first. */
export async function findInactiveGuests(db: D1Database, now: Date, limit = GUEST_CLEANUP_BATCH): Promise<string[]> {
  const noRunsCutoff = new Date(now.getTime() - GUEST_NO_RUNS_DAYS * DAY_MS).toISOString();
  const noProgressCutoff = new Date(now.getTime() - GUEST_NO_PROGRESS_DAYS * DAY_MS).toISOString();
  const { results } = await db.prepare(
    `SELECT l.id FROM learners l
     WHERE l.kind = 'guest' AND l.merged_into IS NULL AND l.created_at < ?1
       AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.learner_id = l.id AND s.last_seen_at >= ?1)
       AND NOT EXISTS (SELECT 1 FROM certificates c WHERE c.learner_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM learners m WHERE m.merged_into = l.id)
       AND (
         (NOT EXISTS (SELECT 1 FROM mission_runs r WHERE r.learner_id = l.id)
           AND NOT EXISTS (SELECT 1 FROM lab_runs x WHERE x.learner_id = l.id))
         OR (l.created_at < ?2
           AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.learner_id = l.id AND s.last_seen_at >= ?2)
           AND NOT EXISTS (SELECT 1 FROM mission_runs r WHERE r.learner_id = l.id AND r.updated_at >= ?2)
           AND NOT EXISTS (SELECT 1 FROM xp_ledger x WHERE x.learner_id = l.id)
           AND NOT EXISTS (SELECT 1 FROM badge_grants b WHERE b.learner_id = l.id))
       )
     ORDER BY l.created_at LIMIT ?3`,
  ).bind(noRunsCutoff, noProgressCutoff, limit).all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function removeInactiveGuests(
  env: Pick<Env, 'DB' | 'EVIDENCE'>, now = new Date(), limit = GUEST_CLEANUP_BATCH,
): Promise<GuestCleanupResult> {
  const result: GuestCleanupResult = { removed: 0, failed: 0 };
  for (const id of await findInactiveGuests(env.DB, now, limit)) {
    try {
      // Guests cannot hold /mcp OAuth grants (MCP is member-only), so no grant revoker is needed.
      await deleteLearnerData(env.DB, env.EVIDENCE, id);
      result.removed++;
    } catch (err) {
      result.failed++;
      console.error('guest cleanup failed', id, err instanceof Error ? err.message : err);
    }
  }
  return result;
}
