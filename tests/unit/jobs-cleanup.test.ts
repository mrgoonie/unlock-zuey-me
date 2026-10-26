import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { findInactiveGuests, removeInactiveGuests } from '../../src/lib/jobs/inactive-guest-cleanup';
import { deleteOrphanEvidence, EVIDENCE_GC_CURSOR_KEY } from '../../src/lib/jobs/orphan-evidence-cleanup';

const NOW = new Date('2026-10-26T03:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** R2 stand-in with upload times, prefix listing (sorted, paginated by a numeric cursor) and batch delete. */
function datedBucket(objects: Record<string, Date>, pageSize = 1000) {
  const store = new Map(Object.entries(objects));
  const bucket = {
    list: vi.fn(async (opts: { prefix?: string; cursor?: string; limit?: number }) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const size = Math.min(opts.limit ?? 1000, pageSize);
      const page = keys.slice(start, start + size);
      const truncated = start + size < keys.length;
      return { objects: page.map((key) => ({ key, uploaded: store.get(key)! })), truncated, cursor: truncated ? String(start + size) : undefined };
    }),
    delete: vi.fn(async (keys: string | string[]) => { for (const k of [keys].flat()) store.delete(k); }),
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
      delete: vi.fn(async (k: string) => void store.delete(k)),
    } as unknown as KVNamespace,
  };
}

let db: D1Database;

async function guest(id: string, createdDaysAgo: number, opts: { seenDaysAgo?: number; kind?: 'guest' | 'member'; mergedInto?: string } = {}) {
  const created = daysAgo(createdDaysAgo);
  await db.prepare(`INSERT INTO learners (id, kind, merged_into, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, opts.kind ?? 'guest', opts.mergedInto ?? null, created, created).run();
  const seen = daysAgo(opts.seenDaysAgo ?? createdDaysAgo);
  await db.prepare(`INSERT INTO sessions (id, token_hash, learner_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(`ses_${id}`, `hash_${id}`, id, created, daysAgo(-180), seen).run();
}
async function run(id: string, learnerId: string, status = 'started', updatedDaysAgo = 20) {
  await db.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, started_at, updated_at) VALUES (?, ?, 'plan-weekend', 1, ?, ?, ?)`)
    .bind(id, learnerId, status, daysAgo(updatedDaysAgo), daysAgo(updatedDaysAgo)).run();
}
const exists = async (id: string) => !!(await db.prepare('SELECT 1 AS x FROM learners WHERE id = ?').bind(id).first());

beforeEach(() => {
  db = createTestD1();
});

describe('inactive guest cleanup', () => {
  it('removes guests without runs after 7 days and guests without progress after 30 days', async () => {
    await guest('g_new', 3); // too young
    await guest('g_norun', 8); // no runs, inactive 8 days → removed
    await guest('g_seen', 40, { seenDaysAgo: 2 }); // came back recently → kept
    await guest('g_run_young', 10); // has a run, only 10 days inactive → kept
    await run('run_young', 'g_run_young');
    await guest('g_run_old', 45); // has a run but no progress, 45 days inactive → removed
    await run('run_old', 'g_run_old', 'started', 40);
    await guest('g_progress', 60); // earned XP → kept forever
    await run('run_p', 'g_progress', 'completed', 50);
    await db.prepare(`INSERT INTO xp_ledger (id, learner_id, amount, reason, ref, created_at) VALUES ('xp1', 'g_progress', 50, 'mission_pass', 'run_p', ?)`).bind(daysAgo(50)).run();
    await guest('m_member', 90, { kind: 'member' }); // members are never touched
    await guest('g_merged', 90, { mergedInto: 'm_member' }); // merged guests belong to the member

    expect((await findInactiveGuests(db, NOW)).sort()).toEqual(['g_norun', 'g_run_old']);
    const r2 = datedBucket({ 'ev/g_norun/a.png': hoursAgo(200), 'ev/g_seen/a.png': hoursAgo(200) });
    expect(await removeInactiveGuests({ DB: db, EVIDENCE: r2.bucket }, NOW)).toEqual({ removed: 2, failed: 0 });
    for (const id of ['g_norun', 'g_run_old']) expect(await exists(id), id).toBe(false);
    for (const id of ['g_new', 'g_seen', 'g_run_young', 'g_progress', 'm_member', 'g_merged']) expect(await exists(id), id).toBe(true);
    expect([...r2.store.keys()]).toEqual(['ev/g_seen/a.png']);
    const runsLeft = await db.prepare(`SELECT COUNT(*) AS n FROM mission_runs WHERE learner_id = 'g_run_old'`).first<{ n: number }>();
    expect(runsLeft?.n).toBe(0);
  });

  it('keeps guests holding a certificate', async () => {
    await guest('g_cert', 60);
    await db.prepare(`INSERT INTO certificates (code, learner_id, level, display_name, snapshot_json, issued_at) VALUES ('c1', 'g_cert', 'L1', 'A', '{}', ?)`).bind(daysAgo(59)).run();
    expect(await findInactiveGuests(db, NOW)).toEqual([]);
  });

  it('respects the batch limit', async () => {
    for (let i = 0; i < 5; i++) await guest(`g_${i}`, 10 + i);
    expect(await findInactiveGuests(db, NOW, 2)).toEqual(['g_4', 'g_3']);
  });
});

describe('orphan evidence cleanup', () => {
  beforeEach(async () => {
    await guest('lrn_a', 2);
    await guest('lrn_draft', 2);
    await run('run_a', 'lrn_a', 'completed', 1);
    await db.prepare(`INSERT INTO evidence_submissions (id, run_id, learner_id, idempotency_key, answers_json, image_keys_json, created_at)
      VALUES ('sub_a', 'run_a', 'lrn_a', 'k1', '{}', '["ev/lrn_a/kept.png"]', ?)`).bind(daysAgo(1)).run();
    await run('run_draft', 'lrn_draft', 'awaiting_evidence', 1);
  });

  it('deletes old unreferenced images and keeps submitted, recent and draft images', async () => {
    const r2 = datedBucket({
      'ev/lrn_a/kept.png': hoursAgo(48), // referenced by a submission
      'ev/lrn_a/orphan.png': hoursAgo(48), // never submitted, owner has no open run → deleted
      'ev/lrn_a/fresh.png': hoursAgo(2), // younger than 24 h
      'ev/lrn_draft/draft.png': hoursAgo(48), // owner has an open run touched recently (unsent draft)
      'ev/lrn_gone/old.png': hoursAgo(48), // owner was erased
      'other/thing.png': hoursAgo(48), // outside ev/
    });
    const { kv } = memoryKv();
    const res = await deleteOrphanEvidence({ DB: db, EVIDENCE: r2.bucket, CACHE: kv }, NOW);
    expect(res).toMatchObject({ deleted: 2, completedPass: true });
    expect([...r2.store.keys()].sort()).toEqual(['ev/lrn_a/fresh.png', 'ev/lrn_a/kept.png', 'ev/lrn_draft/draft.png', 'other/thing.png']);
  });

  it('keeps images submitted by a guest that was merged into a member', async () => {
    await guest('m_1', 30, { kind: 'member' });
    await guest('g_old', 30, { mergedInto: 'm_1' });
    await run('run_m', 'm_1', 'completed', 5);
    await db.prepare(`INSERT INTO evidence_submissions (id, run_id, learner_id, idempotency_key, answers_json, image_keys_json, created_at)
      VALUES ('sub_m', 'run_m', 'm_1', 'k1', '{}', '["ev/g_old/x.png"]', ?)`).bind(daysAgo(5)).run();
    const r2 = datedBucket({ 'ev/g_old/x.png': hoursAgo(100), 'ev/g_old/y.png': hoursAgo(100) });
    const { kv } = memoryKv();
    await deleteOrphanEvidence({ DB: db, EVIDENCE: r2.bucket, CACHE: kv }, NOW);
    expect([...r2.store.keys()]).toEqual(['ev/g_old/x.png']);
  });

  it('walks a large bucket across runs with a saved cursor', async () => {
    const objects: Record<string, Date> = {};
    for (let i = 0; i < 5; i++) objects[`ev/lrn_gone/${i}.png`] = hoursAgo(30);
    const r2 = datedBucket(objects, 2);
    const { kv, store } = memoryKv();
    const env = { DB: db, EVIDENCE: r2.bucket, CACHE: kv };
    expect(await deleteOrphanEvidence(env, NOW, 1)).toMatchObject({ scanned: 2, completedPass: false });
    expect(store.get(EVIDENCE_GC_CURSOR_KEY)).toBe('2');
    // Deleting shifts the fake's offsets, which is fine: the pass ends and the next pass starts over.
    await deleteOrphanEvidence(env, NOW, 1);
    await deleteOrphanEvidence(env, NOW, 5);
    await deleteOrphanEvidence(env, NOW, 5);
    expect(r2.store.size).toBe(0);
    expect(store.has(EVIDENCE_GC_CURSOR_KEY)).toBe(false);
  });
});
