/**
 * POST /api/ingest/v1/turns behaviour after authentication: duplicate Stop, re-fire while pending, server
 * redaction, size and schema limits, daily cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as turnsRoute } from '../../src/pages/api/ingest/v1/turns';
import { createToken } from '../../src/lib/insights/ingest-tokens';
import { DAILY_INGEST_CAP_PER_LEARNER, INGEST_DEBOUNCE_MS, ingestTurnV1Schema } from '../../src/lib/insights/ingest-contract';
import { readIngestBody } from '../../src/lib/insights/ingest-service';
import { callRoute, count, ingestRequest, makeEnv, NOW, seedMember, sha, turnPayload, type TestEnv } from './insights-ingest-fixtures';

let t: TestEnv;
let token: string;

const post = (body: unknown, tok = token) => callRoute(turnsRoute, t.env, ingestRequest('/api/ingest/v1/turns', { token: tok, body }));
const rows = () => t.db.prepare(`SELECT * FROM insight_events ORDER BY received_at, id`).all<Record<string, unknown>>().then((r) => r.results);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = makeEnv();
  await seedMember(t.db, 'lrn_a', { analysis: true });
  token = (await createToken(t.db, 'lrn_a', 'MacBook', 'claude-code', NOW))!.token;
});
afterEach(() => vi.useRealTimers());

describe('ingest turns', () => {
  it('accepts a turn as a pending, debounced queue row bound to the token', async () => {
    const res = await post(turnPayload());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, duplicate: false });
    const [row] = await rows();
    expect(row).toMatchObject({
      learner_id: 'lrn_a', status: 'pending', source_runtime: 'claude-code', adapter_version: '0.1.0',
      idempotency_key: sha('session-1:prompt-1'), session_ref: sha('session-1salt'),
      next_attempt_at: new Date(NOW.getTime() + INGEST_DEBOUNCE_MS).toISOString(), received_at: NOW.toISOString(),
    });
    expect(String(row.token_id)).toMatch(/^itk_/);
    const payload = JSON.parse(String(row.payload_json));
    expect(payload).toMatchObject({ v: 1, adapter: 'claude-code', turn: { userPrompt: 'Giúp mình lập kế hoạch cuối tuần' } });
    expect(payload).not.toHaveProperty('idempotencyKey');
    expect(row.payload_bytes).toBe(new TextEncoder().encode(String(row.payload_json)).byteLength);
  });

  it('dedupes a duplicate Stop: same key twice → one row and duplicate:true', async () => {
    expect(await (await post(turnPayload())).json()).toEqual({ accepted: true, duplicate: false });
    expect(await (await post(turnPayload())).json()).toEqual({ accepted: true, duplicate: true });
    expect(await count(t.db, 'SELECT COUNT(*) AS n FROM insight_events')).toBe(1);
  });

  it('replaces the payload of a re-fire while pending, and ignores it once processed', async () => {
    await post(turnPayload());
    const refire = turnPayload({ stopHookActive: true, turnOver: { assistantFinal: 'Bản cập nhật sau khi hook khác yêu cầu tiếp tục.' } });
    expect(await (await post(refire)).json()).toEqual({ accepted: true, duplicate: true });
    let [row] = await rows();
    expect(JSON.parse(String(row.payload_json)).turn.assistantFinal).toBe('Bản cập nhật sau khi hook khác yêu cầu tiếp tục.');

    await t.db.prepare(`UPDATE insight_events SET status = 'done', payload_json = NULL`).run();
    const late = turnPayload({ turnOver: { assistantFinal: 'Không được ghi đè.' } });
    expect(await (await post(late)).json()).toEqual({ accepted: true, duplicate: true });
    [row] = await rows();
    expect(row).toMatchObject({ status: 'done', payload_json: null });
  });

  it('redacts the turn server-side and adds its count to the client count', async () => {
    const secret = `sk-ant-api03-${'a1B2c3D4'.repeat(6)}`;
    const res = await post(turnPayload({
      redaction: { count: 1, kinds: ['bearer'] },
      turnOver: { userPrompt: `Key ${secret}, mail duy@example.com, gọi 0912345678 nhé`, assistantFinal: 'Đã nhận.' },
    }));
    expect(res.status).toBe(202);
    const [row] = await rows();
    const stored = String(row.payload_json);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('duy@example.com');
    expect(stored).not.toContain('0912345678');
    expect(stored).toContain('[REDACTED:api_key]');
    expect(stored).toContain('[REDACTED:email]');
    expect(stored).toContain('[REDACTED:phone]');
    expect(Number(row.redactions)).toBeGreaterThanOrEqual(4);
    const payload = JSON.parse(stored);
    expect(payload.redaction.kinds).toEqual(expect.arrayContaining(['api_key', 'bearer', 'email', 'phone']));
  });

  it('stores what the analyzer reads: a schema-valid turn, payload_bytes, and ISO timestamp strings', async () => {
    const secretRun = `run_${'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI'}`;
    const res = await post(turnPayload({
      turnEndedAt: '2026-10-26T22:59:58+07:00',
      turnOver: {
        userPrompt: 'Mật khẩu: hunter2-secret',
        tools: [{ name: 'Bash', ok: true, count: 2 }, { name: `sk-ant-api03-${'a1B2c3D4'.repeat(6)}`, ok: true, count: 1 }],
        platform: { mcpTools: ['start_mission'], missionId: 'plan-weekend', runId: secretRun },
      },
    }));
    expect(res.status).toBe(202);
    const [row] = await rows();
    const stored = JSON.parse(String(row.payload_json));
    expect(ingestTurnV1Schema.shape.turn.safeParse(stored.turn).success).toBe(true);
    expect(stored.turn.tools.map((t: { name: string }) => t.name)).toEqual(['Bash']);
    expect(stored.turn.platform).toEqual({ mcpTools: ['start_mission'], missionId: 'plan-weekend', runId: null });
    expect(String(row.payload_json)).not.toContain(secretRun);
    expect(row.payload_bytes).toBe(new TextEncoder().encode(String(row.payload_json)).byteLength);
    for (const col of ['next_attempt_at', 'turn_ended_at', 'received_at']) {
      expect(row[col]).toBe(new Date(String(row[col])).toISOString());
    }
    expect(row.turn_ended_at).toBe('2026-10-26T15:59:58.000Z');
  });

  it('re-applies the field caps when placeholders make the text longer', async () => {
    const prompt = Array.from({ length: 800 }, (_, i) => `a${i}@b.co`).join(' ').slice(0, 4000);
    expect((await post(turnPayload({ turnOver: { userPrompt: prompt } }))).status).toBe(202);
    const payload = JSON.parse(String((await rows())[0].payload_json));
    expect(payload.turn.userPrompt.length).toBeLessThanOrEqual(4000);
    expect(payload.truncated).toBe(true);
  });

  it('refuses bodies over 32 KB (declared or streamed) and invalid or non-strict payloads', async () => {
    const big = JSON.stringify({ ...turnPayload(), pad: 'x'.repeat(33 * 1024) });
    let res = await post(big);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid', reason: 'payload_too_large' } });

    const streamed = new Request('https://unlock.zuey.me/x', {
      method: 'POST', body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(40_000))); c.close(); } }),
      duplex: 'half',
    } as RequestInit);
    const read = await readIngestBody(streamed);
    expect('response' in read && read.response.status).toBe(400);

    res = await post('not json');
    expect(await res.json()).toMatchObject({ error: { reason: 'invalid_payload' } });
    res = await post({ ...turnPayload(), cwd: '/Users/duy/secret-project' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { reason: 'invalid_payload' } });
    res = await post(turnPayload({ turnOver: { tools: [{ name: 'Bash', ok: true, count: 1, args: 'rm -rf' } as never] } }));
    expect(res.status).toBe(400);
    expect(await count(t.db, 'SELECT COUNT(*) AS n FROM insight_events')).toBe(0);
  });

  it('enforces the per-learner daily cap counted from received_at (UTC day)', async () => {
    const ins = t.db.prepare(`INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json,
      payload_bytes, status, next_attempt_at, turn_ended_at, received_at) VALUES (?, 'lrn_a', ?, 's', 'claude-code', '0.1.0', NULL, 0, 'done', ?, ?, ?)`);
    const today = '2026-10-26T00:00:01.000Z';
    await t.db.batch(Array.from({ length: DAILY_INGEST_CAP_PER_LEARNER }, (_, i) => ins.bind(`iev_${i}`, `k${i}`, today, today, today)));
    const res = await post(turnPayload());
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'budget_exceeded', reason: 'daily_cap' } });
    // Yesterday's rows do not count.
    await t.db.prepare(`UPDATE insight_events SET received_at = '2026-10-25T23:59:59.000Z' WHERE id = 'iev_0'`).run();
    expect((await post(turnPayload())).status).toBe(202);
  });
});
