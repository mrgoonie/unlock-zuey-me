/**
 * Device pairing: start → confirm (web session, members only) → poll returns the token exactly once;
 * denied/expired → 410; polling faster than every 4 s → 429 slow_down; wrong code → 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as startRoute } from '../../src/pages/api/ingest/v1/pair/start';
import { POST as pollRoute } from '../../src/pages/api/ingest/v1/pair/poll';
import { POST as confirmRoute } from '../../src/pages/api/v1/insights/pair/confirm';
import { POST as turnsRoute } from '../../src/pages/api/ingest/v1/turns';
import { generateUserCode, peekPairing } from '../../src/lib/insights/device-pairing';
import { setConsents } from '../../src/lib/insights/consent-store';
import { INGEST_TOKEN_PATTERN, PAIR_USER_CODE_PATTERN, type PairStartResponse } from '../../src/lib/insights/ingest-contract';
import { learnerCtx } from './observer-seed-fixtures';
import { callRoute, count, ingestRequest, makeEnv, NOW, SITE, seedMember, turnPayload, type TestEnv } from './insights-ingest-fixtures';

let t: TestEnv;

const start = async (body: unknown = { label: 'MacBook của Duy', adapter: 'claude-code' }, headers?: Record<string, string>) =>
  callRoute(startRoute, t.env, ingestRequest('/api/ingest/v1/pair/start', { body, headers }));
const poll = (deviceCode: string) => callRoute(pollRoute, t.env, ingestRequest('/api/ingest/v1/pair/poll', { body: { deviceCode } }));
const confirm = (userCode: string, approve: boolean, learner: unknown = learnerCtx('lrn_a')) => callRoute(confirmRoute, t.env,
  new Request(`${SITE}/api/v1/insights/pair/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userCode, approve }) }),
  { learner });
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = makeEnv();
  await seedMember(t.db, 'lrn_a');
});
afterEach(() => vi.useRealTimers());

async function started(): Promise<PairStartResponse> {
  const res = await start();
  expect(res.status).toBe(200);
  return res.json() as Promise<PairStartResponse>;
}

describe('device pairing', () => {
  it('issues codes in the contract format and stores no raw device code', async () => {
    const s = await started();
    expect(s).toEqual({
      deviceCode: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), userCode: expect.stringMatching(PAIR_USER_CODE_PATTERN),
      verificationUri: 'https://unlock.zuey.me/insights/pair', interval: 5, expiresIn: 600,
    });
    expect([...t.store.keys()].some((k) => k.includes(s.deviceCode))).toBe(false);
    expect([...t.store.values()].some((v) => v.value.includes(s.deviceCode))).toBe(false);
    for (let i = 0; i < 50; i++) expect(generateUserCode()).toMatch(PAIR_USER_CODE_PATTERN);
    expect(await peekPairing(t.env.CACHE, s.userCode.toLowerCase().replace('-', ''))).toMatchObject({ label: 'MacBook của Duy', adapter: 'claude-code' });
  });

  it('approve → first poll returns a working token, second poll 410', async () => {
    const s = await started();
    let res = await poll(s.deviceCode);
    expect(res.status).toBe(428);
    expect(await res.json()).toEqual({ status: 'pending' });

    // Typed lower-case without the dash is accepted.
    res = await confirm(s.userCode.toLowerCase().replace('-', ''), true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'approved' });
    expect((await confirm(s.userCode, true)).status).toBe(404);

    advance(5_000);
    res = await poll(s.deviceCode);
    expect(res.status).toBe(200);
    const { token, expiresAt } = await res.json() as { token: string; expiresAt: string };
    expect(token).toMatch(INGEST_TOKEN_PATTERN);
    expect(expiresAt).toBe(new Date(Date.now() + 90 * 86_400_000).toISOString());
    expect(await count(t.db, `SELECT COUNT(*) AS n FROM insight_tokens WHERE learner_id = 'lrn_a' AND label = 'MacBook của Duy'`)).toBe(1);

    advance(5_000);
    res = await poll(s.deviceCode);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ status: 'expired' });

    await setConsents(t.db, 'lrn_a', { analysis: true });
    const ingest = await callRoute(turnsRoute, t.env, ingestRequest('/api/ingest/v1/turns', { token, body: turnPayload({ sentAt: new Date().toISOString() }) }));
    expect(ingest.status).toBe(202);
  });

  it('denied → 410 denied, and no token is minted', async () => {
    const s = await started();
    expect(await (await confirm(s.userCode, false)).json()).toEqual({ status: 'denied' });
    const res = await poll(s.deviceCode);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ status: 'denied' });
    expect(await count(t.db, 'SELECT COUNT(*) AS n FROM insight_tokens')).toBe(0);
  });

  it('expires after 10 minutes: confirm → 404, poll → 410 expired', async () => {
    const s = await started();
    advance(601_000);
    expect((await confirm(s.userCode, true)).status).toBe(404);
    const res = await poll(s.deviceCode);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ status: 'expired' });
  });

  it('answers 429 slow_down when polled faster than every 4 s', async () => {
    const s = await started();
    expect((await poll(s.deviceCode)).status).toBe(428);
    advance(2_000);
    const res = await poll(s.deviceCode);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited', reason: 'slow_down' } });
    advance(4_000);
    expect((await poll(s.deviceCode)).status).toBe(428);
  });

  it('confirm: guest → 403 sign-in, wrong code → 404, flag off → 404, no session → 401', async () => {
    const s = await started();
    const guest = await confirm(s.userCode, true, learnerCtx('lrn_g', { kind: 'guest', email: null }));
    expect(guest.status).toBe(403);
    expect(((await guest.json()) as { error: { message: string } }).error.message).toMatch(/đăng nhập/);
    expect((await confirm('ABCD-EFGH', true)).status).toBe(404);
    expect((await confirm('not-a-code!', true)).status).toBe(404);
    expect((await confirm(s.userCode, true, null)).status).toBe(401);
    t.env.INSIGHTS_MODE = 'internal';
    expect((await confirm(s.userCode, true)).status).toBe(404);
    t.env.INSIGHTS_MODE = 'off';
    expect((await confirm(s.userCode, true, learnerCtx('lrn_a', { isAdmin: true }))).status).toBe(404);
    t.env.INSIGHTS_MODE = 'on';
    expect((await confirm(s.userCode, true)).status).toBe(200);
  });

  it('start/poll: validate input, refuse an Origin header, 404 while the flag is off', async () => {
    expect((await start({ label: '', adapter: 'claude-code' })).status).toBe(400);
    expect((await start({ label: 'x', adapter: 'cursor' })).status).toBe(400);
    expect((await start({ label: 'x', adapter: 'claude-code', learnerId: 'lrn_a' })).status).toBe(400);
    expect((await start(JSON.stringify({ label: 'x'.repeat(2_000), adapter: 'claude-code' }))).status).toBe(400);
    expect((await poll('short')).status).toBe(400);
    const res = await start(undefined, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { reason: 'origin_forbidden' } });
    t.env.INSIGHTS_MODE = 'off';
    expect((await start()).status).toBe(404);
    expect((await poll('A'.repeat(43))).status).toBe(404);
  });

  it('does not mint for a learner deleted after approving', async () => {
    const s = await started();
    await confirm(s.userCode, true);
    await t.db.prepare(`UPDATE learners SET deleted_at = ? WHERE id = 'lrn_a'`).bind(NOW.toISOString()).run();
    advance(5_000);
    expect((await poll(s.deviceCode)).status).toBe(410);
    expect(await count(t.db, 'SELECT COUNT(*) AS n FROM insight_tokens')).toBe(0);
  });
});
