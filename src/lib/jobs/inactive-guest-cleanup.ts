/**
 * Cron cleanup of abandoned guest learners. Every cookie-less browser visit creates a guest, so guests that
 * never came back would pile up forever. A guest is removed (every learner-owned row, then its evidence
 * images) when it has not been seen for a while:
 * - no mission or lab run at all and inactive for GUEST_NO_RUNS_DAYS, or
 * - no progress (no XP, badge or recent run) and inactive for GUEST_NO_PROGRESS_DAYS.
 * Guests merged into a member, guests holding a certificate and guests with any progress are never removed.
 * "Inactive" means created before the cutoff and no session seen since then (sessions refresh daily).
 *
 * The scan and the deletion are separate steps, and a guest can sign in (and be merged into a member)
 * in between. So the deletion re-checks eligibility inside its own atomic D1 batch: the first statement
 * marks the guest (deleted_at) only if it is STILL an unmerged, inactive guest, and every following DELETE
 * applies only to a guest carrying that mark. R2 images are removed only after that batch actually deleted
 * the guest row, so images of a guest that got merged meanwhile are never touched. If the R2 step fails,
 * the images belong to a learner that no longer exists and the orphan-evidence job removes them later.
 */
import { listR2Keys } from '../privacy/export-learner-data';
import { evidencePrefix, LEARNER_TABLES } from '../privacy/learner-data-tables';
import { createCronBudget, type CronBudget } from './cron-budget';

export const GUEST_NO_RUNS_DAYS = 7;
export const GUEST_NO_PROGRESS_DAYS = 30;
/** Guests removed per cron run (each removal is a handful of D1/R2 subrequests). */
export const GUEST_CLEANUP_BATCH = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GuestCleanupResult {
  removed: number;
  /** Guests that stopped qualifying between the scan and the deletion (e.g. merged at sign-in). */
  skipped: number;
  failed: number;
  /** True when the run budget ran out before every found guest was handled. */
  deferred: boolean;
}

/**
 * SQL predicate (on alias `l`) for "guest that may be removed". ?1 = no-runs cutoff, ?2 = no-progress
 * cutoff. Shared by the scan and the deletion-time re-check so both apply exactly the same rule.
 */
const ELIGIBLE_GUEST = `l.kind = 'guest' AND l.merged_into IS NULL AND l.deleted_at IS NULL AND l.created_at < ?1
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
       )`;

function cutoffs(now: Date): [string, string] {
  return [
    new Date(now.getTime() - GUEST_NO_RUNS_DAYS * DAY_MS).toISOString(),
    new Date(now.getTime() - GUEST_NO_PROGRESS_DAYS * DAY_MS).toISOString(),
  ];
}

/** Ids of guests that qualify for removal, oldest first. */
export async function findInactiveGuests(db: D1Database, now: Date, limit = GUEST_CLEANUP_BATCH): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT l.id FROM learners l WHERE ${ELIGIBLE_GUEST} ORDER BY l.created_at LIMIT ?3`,
  ).bind(...cutoffs(now), limit).all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Deletes one guest's D1 rows in one atomic batch, but only if it still qualifies at that moment.
 * Returns true when the guest row was deleted.
 */
async function deleteGuestRowsIfStillEligible(db: D1Database, guestId: string, now: Date): Promise<boolean> {
  const mark = now.toISOString();
  // Guests cannot hold /mcp OAuth grants (MCP is member-only), so there is nothing to revoke in KV.
  const marked = `EXISTS (SELECT 1 FROM learners g WHERE g.id = ?1 AND g.kind = 'guest' AND g.merged_into IS NULL AND g.deleted_at = ?2)`;
  const results = await db.batch([
    db.prepare(`UPDATE learners SET deleted_at = ?4 WHERE id = ?3 AND id IN (SELECT l.id FROM learners l WHERE ${ELIGIBLE_GUEST})`)
      .bind(...cutoffs(now), guestId, mark),
    ...LEARNER_TABLES.map((t) => db.prepare(`DELETE FROM ${t.table} WHERE ${t.column} = ?1 AND ${marked}`).bind(guestId, mark)),
    db.prepare(`DELETE FROM learners WHERE id = ?1 AND ${marked}`).bind(guestId, mark),
  ]);
  return Number(results[results.length - 1]?.meta?.changes ?? 0) > 0;
}

/** Subrequests one removal costs at least: the D1 batch, one R2 list page and one R2 delete. */
const SUBREQUESTS_PER_GUEST = 3;

export async function removeInactiveGuests(
  env: Pick<Env, 'DB' | 'EVIDENCE'>, now = new Date(), limit = GUEST_CLEANUP_BATCH, budget: CronBudget = createCronBudget(),
): Promise<GuestCleanupResult> {
  const result: GuestCleanupResult = { removed: 0, skipped: 0, failed: 0, deferred: false };
  if (budget.exhausted()) return { ...result, deferred: true };
  const take = Math.min(limit, Math.floor((budget.remainingSubrequests() - 1) / SUBREQUESTS_PER_GUEST));
  if (take <= 0) return { ...result, deferred: true };
  budget.charge(1);
  const ids = await findInactiveGuests(env.DB, now, take);
  for (const id of ids) {
    if (budget.exhausted()) {
      result.deferred = true;
      break;
    }
    try {
      budget.charge(1);
      if (!(await deleteGuestRowsIfStillEligible(env.DB, id, now))) {
        result.skipped++;
        continue;
      }
      const keys = await listR2Keys(env.EVIDENCE, evidencePrefix(id));
      budget.charge(Math.max(1, Math.ceil(keys.length / 1000)));
      for (let i = 0; i < keys.length; i += 1000) {
        await env.EVIDENCE.delete(keys.slice(i, i + 1000));
        budget.charge(1);
      }
      result.removed++;
    } catch (err) {
      result.failed++;
      console.error('guest cleanup failed', id, err instanceof Error ? err.message : err);
    }
  }
  return result;
}
