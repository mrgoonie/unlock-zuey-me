/**
 * The three insights consents and their effect on ingest: defaults, dependency on `analysis`, revoke purging
 * the queue in the same batch, ingest refused after a revoke (also when the revoke lands mid-flight),
 * settings and per-device revoke from the web session, and feature gating of those routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATCH as consentRoute } from '../../src/pages/api/v1/insights/consent';
import { GET as settingsRoute } from '../../src/pages/api/v1/insights/settings';
import { DELETE as revokeDeviceRoute } from '../../src/pages/api/v1/insights/tokens/[id]';
import { POST as turnsRoute } from '../../src/pages/api/ingest/v1/turns';
import { CONSENT_SQL, getConsents, setConsents } from '../../src/lib/insights/consent-store';
import { createToken } from '../../src/lib/insights/ingest-tokens';
import { NO_INSIGHT_CONSENTS } from '../../src/lib/insights/insight-types';
import { learnerCtx } from './observer-seed-fixtures';
import { callRoute, count, ingestRequest, makeEnv, NOW, SITE, seedMember, sha, turnPayload, type TestEnv } from './insights-ingest-fixtures';

let t: TestEnv;
let token: string;

const webRequest = (method: string, path: string, body?: unknown) => new Request(`${SITE}${path}`, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const patch = (body: unknown, learner = learnerCtx('lrn_a')) =>
  callRoute(consentRoute, t.env, webRequest('PATCH', '/api/v1/insights/consent', body), { learner });
const ingest = (key = 'k1') => callRoute(turnsRoute, t.env, ingestRequest('/api/ingest/v1/turns', { token, body: turnPayload({ idempotencyKey: sha(key) }) }));
const events = () => count(t.db, `SELECT COUNT(*) AS n FROM insight_events WHERE learner_id = 'lrn_a'`);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = makeEnv();
  await seedMember(t.db, 'lrn_a');
  await seedMember(t.db, 'lrn_b');
  token = (await createToken(t.db, 'lrn_a', 'MacBook', 'claude-code', NOW))!.token;
});
afterEach(() => vi.useRealTimers());

describe('insights consents', () => {
  it('default to all off, independent of observer consent', async () => {
    expect(await getConsents(t.db, 'lrn_a')).toEqual(NO_INSIGHT_CONSENTS);
    const res = await ingest();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden', reason: 'consent_required' } });
    expect(await events()).toBe(0);
  });

  it('requires analysis before shareOperator or proposals (400) and records each change', async () => {
    for (const body of [{ shareOperator: true }, { proposals: true }, { analysis: false, proposals: true }]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid' } });
    }
    expect((await patch({})).status).toBe(400);
    expect((await patch({ analysis: 'yes' })).status).toBe(400);

    const res = await patch({ analysis: true, shareOperator: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { consents: unknown }).consents).toMatchObject({
      analysis: true, shareOperator: true, proposals: false, analysisAt: NOW.toISOString(), shareOperatorAt: NOW.toISOString(), proposalsAt: null,
    });
    const logged = await t.db.prepare(`SELECT name, props_json FROM events WHERE learner_id = 'lrn_a' ORDER BY props_json`).all<{ name: string; props_json: string }>();
    expect(logged.results).toEqual([
      { name: 'consent.granted', props_json: '{"kind":"insights_analysis"}' },
      { name: 'consent.granted', props_json: '{"kind":"insights_share_operator"}' },
    ]);
  });

  it('revoking analysis forces the others off, purges pending/processing rows in the same batch, keeps processed ones', async () => {
    await setConsents(t.db, 'lrn_a', { analysis: true, shareOperator: true, proposals: true }, NOW);
    await setConsents(t.db, 'lrn_b', { analysis: true }, NOW);
    expect((await ingest('k1')).status).toBe(202);
    expect((await ingest('k2')).status).toBe(202);
    await t.db.prepare(`UPDATE insight_events SET status = 'processing' WHERE idempotency_key = ?`).bind(sha('k2')).run();
    expect((await ingest('k3')).status).toBe(202);
    await t.db.prepare(`UPDATE insight_events SET status = 'done', payload_json = NULL WHERE idempotency_key = ?`).bind(sha('k3')).run();
    const tokenB = (await createToken(t.db, 'lrn_b', 'PC', 'claude-code', NOW))!.token;
    await callRoute(turnsRoute, t.env, ingestRequest('/api/ingest/v1/turns', { token: tokenB, body: turnPayload() }));

    const res = await patch({ analysis: false });
    expect(((await res.json()) as { consents: unknown }).consents).toMatchObject({ analysis: false, shareOperator: false, proposals: false });
    const left = await t.db.prepare(`SELECT learner_id, status FROM insight_events ORDER BY learner_id`).all();
    expect(left.results).toEqual([{ learner_id: 'lrn_a', status: 'done' }, { learner_id: 'lrn_b', status: 'pending' }]);

    // Ingest after the revoke: 403 and nothing stored, even with the hook still installed.
    const after = await ingest('k4');
    expect(after.status).toBe(403);
    expect(await events()).toBe(1);
    // Re-enabling analysis does not bring back the others.
    expect(await setConsents(t.db, 'lrn_a', { analysis: true }, NOW)).toMatchObject({ analysis: true, shareOperator: false, proposals: false });
  });

  it('opt-out mid-flight: a revoke between the consent pre-check and the INSERT writes 0 rows and answers 403', async () => {
    await setConsents(t.db, 'lrn_a', { analysis: true }, NOW);
    const realPrepare = t.db.prepare.bind(t.db);
    let revoked = false;
    (t.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!revoked && sql.includes('INSERT INTO insight_events')) {
        revoked = true;
        // Lands after the pre-check, before the guarded INSERT runs.
        realPrepare(`UPDATE insight_consents SET analysis = 0 WHERE learner_id = 'lrn_a'`).run();
      }
      return realPrepare(sql);
    };
    const res = await ingest();
    expect(revoked).toBe(true);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { reason: 'consent_required' } });
    expect(await events()).toBe(0);
  });

  it('exposes SQL fragments that require analysis', async () => {
    await setConsents(t.db, 'lrn_a', { analysis: true, proposals: true }, NOW);
    await setConsents(t.db, 'lrn_b', { analysis: true }, NOW);
    const ids = async (frag: (a: string) => string) => (await t.db.prepare(
      `SELECT l.learner_id FROM (SELECT id AS learner_id FROM learners) l WHERE ${frag('l')} ORDER BY 1`,
    ).all<{ learner_id: string }>()).results.map((r) => r.learner_id);
    expect(await ids(CONSENT_SQL.analysisConsented)).toEqual(['lrn_a', 'lrn_b']);
    expect(await ids(CONSENT_SQL.proposalsConsented)).toEqual(['lrn_a']);
    expect(await ids(CONSENT_SQL.shareOperatorConsented)).toEqual([]);
  });
});

describe('settings and device routes', () => {
  it('lists consents, devices (no hash), queue state and retention', async () => {
    await setConsents(t.db, 'lrn_a', { analysis: true }, NOW);
    await ingest();
    const res = await callRoute(settingsRoute, t.env, webRequest('GET', '/api/v1/insights/settings'), { learner: learnerCtx('lrn_a') });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: true, member: true, consents: { analysis: true },
      queue: { pending: 1, lastReceivedAt: NOW.toISOString() }, retentionDays: 90,
    });
    expect(body.devices).toEqual([{
      id: expect.stringMatching(/^itk_/), label: 'MacBook', adapter: 'claude-code', createdAt: NOW.toISOString(),
      lastUsedAt: NOW.toISOString(), expiresAt: '2027-01-24T16:00:00.000Z',
    }]);
    expect(JSON.stringify(body)).not.toContain('hash');
  });

  it('revokes only the learner\'s own device; another learner\'s id → 404', async () => {
    const id = (await t.db.prepare(`SELECT id FROM insight_tokens WHERE learner_id = 'lrn_a'`).first<string>('id'))!;
    const del = (learner: string, tokenId: string) => callRoute(revokeDeviceRoute, t.env,
      webRequest('DELETE', `/api/v1/insights/tokens/${tokenId}`), { learner: learnerCtx(learner), params: { id: tokenId } });
    expect((await del('lrn_b', id)).status).toBe(404);
    expect((await del('lrn_a', 'itk_unknown')).status).toBe(404);
    expect((await del('lrn_a', '../etc')).status).toBe(404);
    const res = await del('lrn_a', id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect((await del('lrn_a', id)).status).toBe(404);
    await setConsents(t.db, 'lrn_a', { analysis: true }, NOW);
    expect((await ingest()).status).toBe(401);
  });

  it('404 when the feature is off or not enabled for the learner; guests and missing sessions are refused', async () => {
    const calls = (learner: unknown) => [
      callRoute(settingsRoute, t.env, webRequest('GET', '/api/v1/insights/settings'), { learner }),
      callRoute(consentRoute, t.env, webRequest('PATCH', '/api/v1/insights/consent', { analysis: true }), { learner }),
      callRoute(revokeDeviceRoute, t.env, webRequest('DELETE', '/api/v1/insights/tokens/itk_x'), { learner, params: { id: 'itk_x' } }),
    ];
    t.env.INSIGHTS_MODE = 'off';
    for (const res of await Promise.all(calls(learnerCtx('lrn_a', { isAdmin: true })))) expect(res.status).toBe(404);
    t.env.INSIGHTS_MODE = 'internal';
    for (const res of await Promise.all(calls(learnerCtx('lrn_a')))) expect(res.status).toBe(404);
    t.env.INSIGHTS_MODE = 'on';
    for (const res of await Promise.all(calls(learnerCtx('lrn_g', { kind: 'guest', email: null })))) expect(res.status).toBe(404);
    for (const res of await Promise.all(calls(undefined))) expect(res.status).toBe(401);
    expect(await getConsents(t.db, 'lrn_a')).toEqual(NO_INSIGHT_CONSENTS);
  });
});
