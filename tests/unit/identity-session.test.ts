import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { pkceChallenge, randomToken, sha256Hex } from '../../src/lib/identity/identity-crypto';
import { parseProfile, toLearnerContext, type LearnerRow } from '../../src/lib/identity/learner-repository';
import { resolveRequestLearner } from '../../src/lib/identity/request-learner';
import {
  resolveSession, sessionCookieOptions, sessionInsert, SESSION_REFRESH_INTERVAL_MS, SESSION_TTL_SECONDS,
} from '../../src/lib/identity/session-store';

const env = () => ({ DB: createTestD1(), ADMIN_EMAILS: 'Boss@Example.com, other@example.com' });
const t0 = new Date('2026-10-01T00:00:00Z');

describe('session tokens', () => {
  it('mints 32-byte base64url tokens and hashes them with SHA-256', async () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sha256Hex(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(await pkceChallenge(token)).toBe(createHash('sha256').update(token).digest('base64url'));
  });

  it('stores only the token hash and resolves the cookie to its learner', async () => {
    const e = env();
    const created = await resolveRequestLearner(e, { token: undefined, policy: 'create', now: t0 });
    const token = created.setCookieToken!;
    expect(created.learner?.kind).toBe('guest');
    const rows = (await e.DB.prepare('SELECT token_hash FROM sessions').all<{ token_hash: string }>()).results;
    expect(rows).toEqual([{ token_hash: await sha256Hex(token) }]);
    expect(JSON.stringify(rows)).not.toContain(token);

    const again = await resolveRequestLearner(e, { token, policy: 'create', now: new Date(t0.getTime() + 1000) });
    expect(again.learner?.id).toBe(created.learner?.id);
    expect(again.setCookieToken).toBeNull(); // no refresh needed yet
  });

  it('slides the expiry after the refresh interval and rejects expired sessions', async () => {
    const e = env();
    await e.DB.prepare(`INSERT INTO learners (id, kind, created_at, updated_at) VALUES ('lrn_1', 'guest', ?, ?)`).bind(t0.toISOString(), t0.toISOString()).run();
    const s = await sessionInsert(e.DB, 'lrn_1', t0);
    await s.stmt.run();

    const later = new Date(t0.getTime() + SESSION_REFRESH_INTERVAL_MS + 1);
    const refreshed = await resolveRequestLearner(e, { token: s.token, policy: 'read', now: later });
    expect(refreshed.setCookieToken).toBe(s.token);
    const exp = await e.DB.prepare('SELECT expires_at FROM sessions').first<string>('expires_at');
    expect(Date.parse(exp!)).toBe(later.getTime() + SESSION_TTL_SECONDS * 1000);

    const afterExpiry = new Date(later.getTime() + SESSION_TTL_SECONDS * 1000 + 1);
    expect(await resolveSession(e.DB, s.token, afterExpiry)).toBeNull();
  });

  it('ignores malformed or unknown cookies, clears them, and only creates guests when allowed', async () => {
    const e = env();
    expect(await resolveSession(e.DB, "x' OR 1=1 --", t0)).toBeNull();
    const read = await resolveRequestLearner(e, { token: randomToken(), policy: 'read', now: t0 });
    expect(read).toEqual({ learner: null, setCookieToken: null, clearCookie: true });
    const none = await resolveRequestLearner(e, { token: undefined, policy: 'none', now: t0 });
    expect(none.learner).toBeNull();
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM learners').first('n')).toBe(0);
  });

  it('does not resolve sessions of merged or deleted learners', async () => {
    const e = env();
    const g = await resolveRequestLearner(e, { token: undefined, policy: 'create', now: t0 });
    await e.DB.prepare('UPDATE learners SET deleted_at = ? WHERE id = ?').bind(t0.toISOString(), g.learner!.id).run();
    expect(await resolveSession(e.DB, g.setCookieToken!, t0)).toBeNull();
  });

  it('cookie options: HttpOnly, SameSite=Lax, Path=/, 180 days, Secure except on http loopback', () => {
    expect(sessionCookieOptions(new URL('https://unlock.zuey.me/home'))).toEqual({
      httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 180 * 24 * 3600,
    });
    expect(sessionCookieOptions(new URL('http://localhost:4321/')).secure).toBe(false);
    expect(sessionCookieOptions(new URL('http://unlock.zuey.me/')).secure).toBe(true);
  });
});

describe('learner context', () => {
  const row: LearnerRow = {
    id: 'lrn_m', kind: 'member', zuey_sub: 's', email: 'boss@example.com', display_name: 'Boss', avatar_url: null,
    profile_json: '{"goal":"work","reduced_motion":true,"bogus":1,"familiarity":"nope"}', observer_consent: 1,
    merged_into: null, deleted_at: null,
  };
  const admins = new Set(['boss@example.com']);

  it('derives isAdmin from a member email in ADMIN_EMAILS only', () => {
    expect(toLearnerContext(row, admins).isAdmin).toBe(true);
    expect(toLearnerContext({ ...row, email: null }, admins).isAdmin).toBe(false);
    expect(toLearnerContext({ ...row, kind: 'guest' }, admins).isAdmin).toBe(false);
  });

  it('parses profile_json tolerantly', () => {
    expect(parseProfile(row.profile_json)).toEqual({ goal: 'work', reducedMotion: true });
    expect(parseProfile('not json')).toEqual({});
    expect(toLearnerContext(row, admins).observerConsent).toBe(true);
  });
});
