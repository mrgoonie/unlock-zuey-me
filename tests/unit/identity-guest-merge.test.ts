/** Guest → member sign-in against the real schema (node:sqlite D1 helper). */
import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { sha256Hex } from '../../src/lib/identity/identity-crypto';
import { completeMemberSignIn } from '../../src/lib/identity/member-sign-in';
import { sessionInsert } from '../../src/lib/identity/session-store';
import type { ZueyUserinfo } from '../../src/lib/identity/zuey-oauth-client';

const now = new Date('2026-10-20T10:00:00Z');
const userinfo: ZueyUserinfo = { sub: 'zuey-42', email: 'duy@example.com', emailVerified: true, name: 'Duy', picture: null };

async function learner(db: D1Database, id: string, kind: 'guest' | 'member', extra: { sub?: string; profile?: string } = {}) {
  await db.prepare(`INSERT INTO learners (id, kind, zuey_sub, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, kind, extra.sub ?? null, extra.profile ?? '{}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z').run();
}

async function run(db: D1Database, id: string, learnerId: string) {
  await db.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, started_at, updated_at) VALUES (?, ?, 'plan-weekend', 1, 'completed', ?, ?)`)
    .bind(id, learnerId, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z').run();
}

const exec = (db: D1Database, sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).run();
const all = async (db: D1Database, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all()).results;

describe('completeMemberSignIn', () => {
  it('merges a guest into an existing member atomically, respecting uniqueness', async () => {
    const db = createTestD1();
    await learner(db, 'lrn_m', 'member', { sub: 'zuey-42' });
    await learner(db, 'lrn_g', 'guest', { profile: '{"goal":"work"}' });
    await run(db, 'run_g', 'lrn_g');
    await run(db, 'run_m', 'lrn_m');
    await exec(db, `INSERT INTO evidence_submissions (id, run_id, learner_id, idempotency_key, answers_json, created_at) VALUES ('sub_g', 'run_g', 'lrn_g', 'k1', '{}', 'x')`);
    await exec(db, `INSERT INTO evaluations (id, run_id, submission_id, learner_id, status, score, criteria_json, feedback, mode, created_at) VALUES ('evl_g', 'run_g', 'sub_g', 'lrn_g', 'passed', 0.9, '[]', 'ok', 'deterministic', 'x')`);
    // xp: one unique to the guest, one duplicate (same reason+ref) that must not be paid twice.
    await exec(db, `INSERT INTO xp_ledger (id, learner_id, amount, reason, ref, created_at) VALUES
      ('xp1', 'lrn_g', 50, 'mission', 'run_g', 'x'), ('xp2', 'lrn_g', 10, 'daily', '2026-10-01', 'x'), ('xp3', 'lrn_m', 10, 'daily', '2026-10-01', 'x')`);
    await exec(db, `INSERT INTO badge_grants (learner_id, badge_id, ref, granted_at) VALUES
      ('lrn_g', 'first', 'run_g', '2026-10-02T00:00:00Z'), ('lrn_m', 'first', 'run_m', '2026-10-05T00:00:00Z'), ('lrn_g', 'only-guest', NULL, '2026-10-03T00:00:00Z')`);
    await exec(db, `INSERT INTO activity_days (learner_id, day) VALUES ('lrn_g', '2026-10-01'), ('lrn_g', '2026-10-02'), ('lrn_m', '2026-10-02')`);
    await exec(db, `INSERT INTO concept_views (learner_id, concept_id, first_seen_at) VALUES ('lrn_g', 'prompt', '2026-10-01'), ('lrn_m', 'prompt', '2026-10-09')`);
    await exec(db, `INSERT INTO competency_scores (learner_id, competency, score, evidence_count, updated_at) VALUES
      ('lrn_g', 'verify', 0.8, 2, '2026-10-02'), ('lrn_m', 'verify', 0.5, 3, '2026-10-05'), ('lrn_g', 'describe', 0.4, 1, '2026-10-02')`);
    await exec(db, `INSERT INTO lab_runs (id, learner_id, lab_id, result_json, created_at) VALUES ('lab1', 'lrn_g', 'context-lab', '{}', 'x')`);
    await exec(db, `INSERT INTO coach_messages (id, learner_id, channel, role, content, created_at) VALUES ('cm1', 'lrn_g', 'hint', 'user', 'hi', 'x')`);
    await exec(db, `INSERT INTO events (id, learner_id, name, occurred_at) VALUES ('evt1', 'lrn_g', 'mission.started', 'x')`);
    await exec(db, `INSERT INTO push_subscriptions (id, learner_id, endpoint, p256dh, auth, created_at) VALUES ('ps1', 'lrn_g', 'https://push/1', 'p', 'a', 'x')`);
    await exec(db, `INSERT INTO certificates (code, learner_id, level, display_name, snapshot_json, issued_at) VALUES
      ('C-G1', 'lrn_g', 'L1', 'G', '{}', 'x'), ('C-M1', 'lrn_m', 'L1', 'M', '{}', 'x'), ('C-G2', 'lrn_g', 'L2', 'G', '{}', 'x')`);
    const guestSession = await sessionInsert(db, 'lrn_g', now);
    await guestSession.stmt.run();

    const result = await completeMemberSignIn(db, {
      userinfo, current: { id: 'lrn_g', kind: 'guest' }, oldSessionToken: guestSession.token, now,
    });

    expect(result).toMatchObject({ memberId: 'lrn_m', guestOutcome: 'merged', guestId: 'lrn_g', newMember: false });
    for (const t of ['mission_runs', 'evidence_submissions', 'evaluations', 'lab_runs', 'coach_messages', 'events', 'push_subscriptions']) {
      expect(await all(db, `SELECT learner_id FROM ${t} WHERE learner_id = 'lrn_g'`), t).toHaveLength(0);
    }
    expect(await all(db, `SELECT id FROM mission_runs WHERE learner_id = 'lrn_m' ORDER BY id`)).toEqual([{ id: 'run_g' }, { id: 'run_m' }]);
    expect(await db.prepare(`SELECT SUM(amount) AS s FROM xp_ledger WHERE learner_id = 'lrn_m'`).first('s')).toBe(60);
    expect(await all(db, `SELECT id FROM xp_ledger WHERE learner_id = 'lrn_g'`)).toEqual([{ id: 'xp2' }]);
    expect(await all(db, `SELECT badge_id, ref, granted_at FROM badge_grants WHERE learner_id = 'lrn_m' ORDER BY badge_id`)).toEqual([
      { badge_id: 'first', ref: 'run_g', granted_at: '2026-10-02T00:00:00Z' },
      { badge_id: 'only-guest', ref: null, granted_at: '2026-10-03T00:00:00Z' },
    ]);
    expect(await all(db, `SELECT day FROM activity_days WHERE learner_id = 'lrn_m' ORDER BY day`)).toEqual([{ day: '2026-10-01' }, { day: '2026-10-02' }]);
    expect(await db.prepare(`SELECT first_seen_at FROM concept_views WHERE learner_id = 'lrn_m'`).first('first_seen_at')).toBe('2026-10-01');
    expect(await all(db, `SELECT competency, score, evidence_count, updated_at FROM competency_scores WHERE learner_id = 'lrn_m' ORDER BY competency`)).toEqual([
      { competency: 'describe', score: 0.4, evidence_count: 1, updated_at: '2026-10-02' },
      { competency: 'verify', score: 0.8, evidence_count: 5, updated_at: '2026-10-05' },
    ]);
    expect(await all(db, `SELECT code, learner_id FROM certificates ORDER BY code`)).toEqual([
      { code: 'C-G1', learner_id: 'lrn_g' }, { code: 'C-G2', learner_id: 'lrn_m' }, { code: 'C-M1', learner_id: 'lrn_m' },
    ]);
    const member = await db.prepare(`SELECT email, display_name, profile_json FROM learners WHERE id = 'lrn_m'`).first();
    expect(member).toEqual({ email: 'duy@example.com', display_name: 'Duy', profile_json: '{"goal":"work"}' });
    expect(await db.prepare(`SELECT merged_into FROM learners WHERE id = 'lrn_g'`).first('merged_into')).toBe('lrn_m');
    // Session rotated: the guest's session is gone, exactly one new member session with a new token.
    const sessions = await all(db, 'SELECT learner_id, token_hash FROM sessions');
    expect(sessions).toEqual([{ learner_id: 'lrn_m', token_hash: await sha256Hex(result.sessionToken) }]);
    expect(result.sessionToken).not.toBe(guestSession.token);
  });

  it('promotes the guest in place when this zuey account is new', async () => {
    const db = createTestD1();
    await learner(db, 'lrn_g', 'guest');
    await run(db, 'run_g', 'lrn_g');
    const result = await completeMemberSignIn(db, {
      userinfo: { ...userinfo, emailVerified: false }, current: { id: 'lrn_g', kind: 'guest' }, oldSessionToken: undefined, now,
    });
    expect(result).toMatchObject({ memberId: 'lrn_g', guestOutcome: 'promoted', newMember: true });
    const row = await db.prepare(`SELECT kind, zuey_sub, email FROM learners WHERE id = 'lrn_g'`).first();
    expect(row).toEqual({ kind: 'member', zuey_sub: 'zuey-42', email: null }); // unverified email is not stored
  });

  it('rolls the whole batch back when one statement fails', async () => {
    const db = createTestD1();
    await learner(db, 'lrn_m', 'member', { sub: 'zuey-42' });
    await learner(db, 'lrn_g', 'guest');
    await run(db, 'run_g', 'lrn_g');
    await exec(db, 'CREATE TRIGGER fail_merge BEFORE UPDATE OF merged_into ON learners BEGIN SELECT RAISE(ABORT, \'boom\'); END');
    await expect(completeMemberSignIn(db, { userinfo, current: { id: 'lrn_g', kind: 'guest' }, oldSessionToken: undefined, now })).rejects.toThrow();
    expect(await db.prepare(`SELECT learner_id FROM mission_runs WHERE id = 'run_g'`).first('learner_id')).toBe('lrn_g');
    expect(await all(db, 'SELECT id FROM sessions')).toHaveLength(0);
  });

  it('creates a fresh member when a deleted account held the zuey identity', async () => {
    const db = createTestD1();
    await learner(db, 'lrn_old', 'member', { sub: 'zuey-42' });
    await exec(db, `UPDATE learners SET deleted_at = 'x' WHERE id = 'lrn_old'`);
    const result = await completeMemberSignIn(db, { userinfo, current: null, oldSessionToken: undefined, now });
    expect(result.memberId).not.toBe('lrn_old');
    expect(await db.prepare(`SELECT zuey_sub FROM learners WHERE id = 'lrn_old'`).first('zuey_sub')).toBeNull();
    expect(await db.prepare('SELECT kind FROM learners WHERE id = ?').bind(result.memberId).first('kind')).toBe('member');
  });
});
