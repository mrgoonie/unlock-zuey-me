import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { GET as exportRoute } from '../../src/pages/api/v1/me/export';
import { POST as deleteRoute } from '../../src/pages/api/v1/me/delete';
import { deleteLearnerData, expireAllCookies } from '../../src/lib/privacy/delete-learner-data';
import type { LearnerExport } from '../../src/lib/privacy/export-learner-data';
import { LEARNER_TABLES } from '../../src/lib/privacy/learner-data-tables';
import { fakeBucket, learnerCtx, routeContext, seedLearner } from './observer-seed-fixtures';

let db: D1Database;
let r2: ReturnType<typeof fakeBucket>;

beforeEach(async () => {
  db = createTestD1();
  await seedLearner(db, 'lrn_me', { consent: true });
  await seedLearner(db, 'lrn_you', { consent: true });
  r2 = fakeBucket(['ev/lrn_me/a.png', 'ev/lrn_me/b.png', 'ev/lrn_you/a.png']);
});

async function tablesWithLearnerColumn(): Promise<string[]> {
  const r = await db.prepare(
    `SELECT m.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) p
     WHERE m.type = 'table' AND p.name = 'learner_id' ORDER BY m.name`,
  ).all<{ name: string }>();
  return r.results.map((x) => x.name);
}

async function rowCount(table: string, learnerId: string): Promise<number> {
  const col = table === 'learners' ? 'id' : 'learner_id';
  return Number(await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(learnerId).first('n'));
}

const deleteRequest = (confirm: string, cookie = 'ss=abc; theme=x') => new Request('https://unlock.zuey.me/api/v1/me/delete', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ confirm }),
});

describe('learner table registry', () => {
  it('covers every table that has a learner_id column', async () => {
    expect(LEARNER_TABLES.map((t) => t.table).sort()).toEqual(await tablesWithLearnerColumn());
  });
});

describe('GET /api/v1/me/export', () => {
  it("returns a JSON attachment with the learner's data and nobody else's", async () => {
    const res = await exportRoute(routeContext({ learner: learnerCtx('lrn_me'), env: { DB: db, EVIDENCE: r2.bucket } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="ai-unlocked-du-lieu-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await res.text();
    const data = JSON.parse(text) as LearnerExport;

    expect(data.learnerId).toBe('lrn_me');
    expect(data.learners.map((l) => l.id)).toEqual(['lrn_me']);
    for (const t of LEARNER_TABLES) expect(data.tables[t.table].length, t.table).toBeGreaterThan(0);
    expect(data.tables.evidence_submissions[0].answers).toEqual({ constraints: { budget: 'Ngân sách của lrn_me' } });
    expect(data.tables.coach_messages[0].content).toBe('Câu hỏi của lrn_me');
    expect(data.imageKeys).toEqual(['ev/lrn_me/a.png', 'ev/lrn_me/b.png']);
    // Credentials are not exported.
    expect(data.tables.sessions[0]).not.toHaveProperty('token_hash');
    expect(data.tables.push_subscriptions[0]).not.toHaveProperty('endpoint');
    expect(data.tables.login_requests[0]).not.toHaveProperty('code_verifier');
    expect(text).not.toContain('lrn_you');
  });

  it('includes guest rows merged into the member', async () => {
    const t = '2026-10-01T00:00:00.000Z';
    await db.prepare(`INSERT INTO learners (id, kind, merged_into, created_at, updated_at) VALUES ('lrn_guest', 'guest', 'lrn_me', ?, ?)`).bind(t, t).run();
    await db.prepare(`INSERT INTO concept_views (learner_id, concept_id, first_seen_at) VALUES ('lrn_guest', 'hallucination', ?)`).bind(t).run();
    const res = await exportRoute(routeContext({ learner: learnerCtx('lrn_me'), env: { DB: db } }));
    const data = (await res.json()) as LearnerExport;
    expect(data.tables.concept_views.map((r) => r.concept_id)).toContain('hallucination');
  });
});

describe('POST /api/v1/me/delete', () => {
  it('requires the typed confirmation', async () => {
    const res = await deleteRoute(routeContext({ learner: learnerCtx('lrn_me'), env: { DB: db, EVIDENCE: r2.bucket }, request: deleteRequest('xoa') }));
    expect(res.status).toBe(400);
    expect(await rowCount('learners', 'lrn_me')).toBe(1);
  });

  it('removes every row and image of the learner, ends the session, leaves others intact, and is idempotent', async () => {
    const ctx = () => routeContext({ learner: learnerCtx('lrn_me'), env: { DB: db, EVIDENCE: r2.bucket }, request: deleteRequest('XOA') });
    const res = await deleteRoute(ctx());
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toEqual(expect.arrayContaining([expect.stringMatching(/^ss=; Path=\/; Max-Age=0/), expect.stringMatching(/^theme=;/)]));

    for (const t of [...LEARNER_TABLES.map((x) => x.table), 'learners']) {
      expect(await rowCount(t, 'lrn_me'), t).toBe(0);
      expect(await rowCount(t, 'lrn_you'), t).toBeGreaterThan(0);
    }
    expect([...r2.store]).toEqual(['ev/lrn_you/a.png']);

    const again = await deleteRoute(ctx());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, rowsDeleted: 0, imagesDeleted: 0 });
  });

  it('expires only well-formed cookie names', () => {
    expect(expireAllCookies(null)).toEqual([]);
    expect(expireAllCookies('a=1; bad name=2; __Host-s=3')).toEqual([
      'a=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      '__Host-s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    ]);
  });
});

describe('deleteLearnerData OAuth grants', () => {
  it('revokes every /mcp grant of the learner across pages, and nobody elses', async () => {
    const grants: Record<string, string[]> = { lrn_me: ['g1', 'g2', 'g3'], lrn_you: ['g9'] };
    const revoked: string[] = [];
    const oauth = {
      async listUserGrants(userId: string, o?: { limit?: number; cursor?: string }) {
        const all = grants[userId] ?? [];
        const start = o?.cursor ? Number(o.cursor) : 0;
        const end = start + 2;
        return { items: all.slice(start, end).map((id) => ({ id })), cursor: end < all.length ? String(end) : undefined };
      },
      async revokeGrant(grantId: string, userId: string) { revoked.push(`${userId}:${grantId}`); },
    };
    const result = await deleteLearnerData(db, r2.bucket, 'lrn_me', oauth);
    expect(result.grantsRevoked).toBe(3);
    expect(revoked).toEqual(['lrn_me:g1', 'lrn_me:g2', 'lrn_me:g3']);
  });

  it('does not delete D1 rows when revocation fails, so a retry can finish', async () => {
    const oauth = {
      async listUserGrants() { throw new Error('kv down'); },
      async revokeGrant() {},
    };
    await expect(deleteLearnerData(db, r2.bucket, 'lrn_me', oauth)).rejects.toThrow('kv down');
    expect(await rowCount('learners', 'lrn_me')).toBe(1);
  });
});
