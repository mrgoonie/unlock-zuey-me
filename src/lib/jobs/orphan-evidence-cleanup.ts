/**
 * Cron cleanup of evidence screenshots that were uploaded but never submitted. Uploads go to R2 straight
 * away (`ev/<learnerId>/<id>.<ext>`) while the draft that holds the key lives only in the browser, so an
 * abandoned or scripted upload would stay in R2 forever.
 *
 * An object is deleted when ALL of these hold:
 * - it was uploaded more than ORPHAN_MIN_AGE_HOURS ago;
 * - no evidence submission of its owner (or of the member the owner was merged into) references it;
 * - its owner has no open mission run touched in the last OPEN_RUN_GRACE_DAYS (the image may still be
 *   attached to an unsent draft, and deleting it would lose the learner's work);
 * or simply when its owner no longer exists.
 *
 * The bucket is walked a few pages per run, in key order. The last examined key is kept in CACHE and the
 * next run lists from just after it (R2 `startAfter`), so consecutive runs cover the whole bucket, then the
 * walk starts over. Because the position is a key rather than a page cursor, a run whose cron budget runs
 * out in the middle of a page stops right there and the next run resumes at the following object.
 */
import { evidenceKeyOwner } from '../learning/evidence-store';
import { createCronBudget, type CronBudget } from './cron-budget';

export const ORPHAN_MIN_AGE_HOURS = 24;
export const OPEN_RUN_GRACE_DAYS = 7;
/** R2 list pages (up to 1000 objects each) examined per cron run. */
export const EVIDENCE_GC_PAGES_PER_RUN = 2;
/** CACHE key holding the last examined R2 key of the current walk. */
export const EVIDENCE_GC_POSITION_KEY = 'evidence-gc:after';
const EVIDENCE_PREFIX = 'ev/';
const OPEN_RUN_STATUSES = `'started','paused','awaiting_evidence','evaluating','needs_revision','evaluation_failed'`;
/** One owner lookup: three D1 queries (learner row, submissions, open run). */
const OWNER_LOOKUP_COST = { d1: 3 } as const;
/** R2 delete of the objects already marked on the current page; kept affordable before every other step. */
const FLUSH_COST = { net: 1 } as const;

export interface EvidenceGcResult {
  scanned: number;
  deleted: number;
  /** True when the walk reached the end of the bucket (the next run starts from the beginning). */
  completedPass: boolean;
  /** True when the cron budget ran out mid-walk; the next run resumes from the saved position. */
  deferred: boolean;
}

interface OwnerState {
  /** Null when the owner row no longer exists. */
  referenced: Set<string> | null;
  hasRecentOpenRun: boolean;
}

async function ownerState(db: D1Database, ownerId: string, openRunSince: string): Promise<OwnerState> {
  const owner = await db.prepare('SELECT id, merged_into FROM learners WHERE id = ?').bind(ownerId).first<{ id: string; merged_into: string | null }>();
  if (!owner) return { referenced: null, hasRecentOpenRun: false };
  const ids = owner.merged_into ? [owner.id, owner.merged_into] : [owner.id];
  const inList = ids.map(() => '?').join(', ');
  const subs = await db.prepare(`SELECT image_keys_json FROM evidence_submissions WHERE learner_id IN (${inList})`)
    .bind(...ids).all<{ image_keys_json: string }>();
  const referenced = new Set<string>();
  for (const s of subs.results) {
    try {
      const keys: unknown = JSON.parse(s.image_keys_json);
      if (Array.isArray(keys)) for (const k of keys) if (typeof k === 'string') referenced.add(k);
    } catch {
      // A corrupt row references nothing.
    }
  }
  const open = await db.prepare(
    `SELECT 1 AS x FROM mission_runs WHERE learner_id IN (${inList}) AND status IN (${OPEN_RUN_STATUSES}) AND updated_at >= ? LIMIT 1`,
  ).bind(...ids, openRunSince).first<{ x: number }>();
  return { referenced, hasRecentOpenRun: !!open };
}

export async function deleteOrphanEvidence(
  env: Pick<Env, 'DB' | 'EVIDENCE' | 'CACHE'>, now = new Date(), pages = EVIDENCE_GC_PAGES_PER_RUN,
  budget: CronBudget = createCronBudget(),
): Promise<EvidenceGcResult> {
  const result: EvidenceGcResult = { scanned: 0, deleted: 0, completedPass: false, deferred: false };
  // The position read and the final write/delete are two KV calls; at least one list page must fit after them.
  if (!budget.canAfford({ net: 2 + 1 + FLUSH_COST.net })) return { ...result, deferred: true };
  const uploadedBefore = now.getTime() - ORPHAN_MIN_AGE_HOURS * 60 * 60 * 1000;
  const openRunSince = new Date(now.getTime() - OPEN_RUN_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  budget.charge({ net: 2 });
  const saved = (await env.CACHE.get(EVIDENCE_GC_POSITION_KEY)) ?? undefined;
  let after = saved;
  const owners = new Map<string, OwnerState>();

  walk: for (let page = 0; page < pages; page++) {
    if (!budget.canAfford({ net: 1 + FLUSH_COST.net })) {
      result.deferred = true;
      break;
    }
    budget.charge({ net: 1 });
    const listing = await env.EVIDENCE.list({ prefix: EVIDENCE_PREFIX, startAfter: after, limit: 1000 });
    const doomed: string[] = [];
    const flush = async () => {
      if (doomed.length === 0) return;
      budget.charge(FLUSH_COST);
      await env.EVIDENCE.delete(doomed);
      result.deleted += doomed.length;
    };
    for (const obj of listing.objects) {
      const ownerId = obj.uploaded.getTime() > uploadedBefore ? null : evidenceKeyOwner(obj.key);
      // ownerId stays null for recent uploads and for keys the app did not write (left for a human).
      if (ownerId) {
        let state = owners.get(ownerId);
        if (!state) {
          if (!budget.canAfford({ d1: OWNER_LOOKUP_COST.d1, net: FLUSH_COST.net })) {
            // Stop before this object; `after` still points at the last one fully examined.
            await flush();
            result.deferred = true;
            break walk;
          }
          budget.charge(OWNER_LOOKUP_COST);
          state = await ownerState(env.DB, ownerId, openRunSince);
          owners.set(ownerId, state);
        }
        const orphan = state.referenced === null || (!state.referenced.has(obj.key) && !state.hasRecentOpenRun);
        if (orphan) doomed.push(obj.key);
      }
      result.scanned++;
      after = obj.key;
    }
    await flush();
    if (!listing.truncated) {
      result.completedPass = true;
      after = undefined;
      break;
    }
  }

  if (after) await env.CACHE.put(EVIDENCE_GC_POSITION_KEY, after, { expirationTtl: 7 * 24 * 60 * 60 });
  else if (saved) await env.CACHE.delete(EVIDENCE_GC_POSITION_KEY);
  return result;
}
