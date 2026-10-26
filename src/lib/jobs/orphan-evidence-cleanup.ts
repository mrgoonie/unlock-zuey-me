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
 * The bucket is walked a few pages per run; the R2 list cursor is kept in CACHE so consecutive runs cover
 * the whole bucket, then the walk starts over.
 */
import { evidenceKeyOwner } from '../learning/evidence-store';

export const ORPHAN_MIN_AGE_HOURS = 24;
export const OPEN_RUN_GRACE_DAYS = 7;
/** R2 list pages (up to 1000 objects each) examined per cron run. */
export const EVIDENCE_GC_PAGES_PER_RUN = 2;
export const EVIDENCE_GC_CURSOR_KEY = 'evidence-gc:cursor';
const EVIDENCE_PREFIX = 'ev/';
const OPEN_RUN_STATUSES = `'started','paused','awaiting_evidence','evaluating','needs_revision','evaluation_failed'`;

export interface EvidenceGcResult {
  scanned: number;
  deleted: number;
  /** True when the walk reached the end of the bucket (the next run starts from the beginning). */
  completedPass: boolean;
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
): Promise<EvidenceGcResult> {
  const result: EvidenceGcResult = { scanned: 0, deleted: 0, completedPass: false };
  const uploadedBefore = now.getTime() - ORPHAN_MIN_AGE_HOURS * 60 * 60 * 1000;
  const openRunSince = new Date(now.getTime() - OPEN_RUN_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const savedCursor = (await env.CACHE.get(EVIDENCE_GC_CURSOR_KEY)) ?? undefined;
  let cursor = savedCursor;
  const owners = new Map<string, OwnerState>();

  for (let page = 0; page < pages; page++) {
    let listing: R2Objects;
    try {
      listing = await env.EVIDENCE.list({ prefix: EVIDENCE_PREFIX, cursor, limit: 1000 });
    } catch (err) {
      if (!cursor) throw err;
      // A stale cursor must not wedge the job: restart the walk next run.
      console.warn('evidence gc: list with saved cursor failed, restarting', err instanceof Error ? err.message : err);
      cursor = undefined;
      break;
    }
    const doomed: string[] = [];
    for (const obj of listing.objects) {
      result.scanned++;
      if (obj.uploaded.getTime() > uploadedBefore) continue;
      const ownerId = evidenceKeyOwner(obj.key);
      if (!ownerId) continue; // Not an app-written key; leave it for a human.
      let state = owners.get(ownerId);
      if (!state) {
        state = await ownerState(env.DB, ownerId, openRunSince);
        owners.set(ownerId, state);
      }
      const orphan = state.referenced === null || (!state.referenced.has(obj.key) && !state.hasRecentOpenRun);
      if (orphan) doomed.push(obj.key);
    }
    if (doomed.length > 0) {
      await env.EVIDENCE.delete(doomed);
      result.deleted += doomed.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
    if (!cursor) {
      result.completedPass = true;
      break;
    }
  }

  if (cursor) await env.CACHE.put(EVIDENCE_GC_CURSOR_KEY, cursor, { expirationTtl: 7 * 24 * 60 * 60 });
  else if (savedCursor) await env.CACHE.delete(EVIDENCE_GC_CURSOR_KEY);
  return result;
}
