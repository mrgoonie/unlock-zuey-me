/** Ingest wire contract v1 (src/lib/insights/ingest-contract.ts): payload schema, caps, pairing helpers, errors. */
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_FINAL_MAX_CHARS, ingestError, ingestTurnV1Schema, INGEST_ERROR_REASONS, INGEST_TOKEN_PATTERN, normalizeUserCode,
  pairPollSchema, pairStartSchema, PAIR_USER_CODE_ALPHABET, sentAtWithinWindow, TOOLS_MAX, USER_PROMPT_MAX_CHARS, utf8Bytes,
  type IngestTurnV1,
} from '../../src/lib/insights/ingest-contract';

const hex = (c: string) => c.repeat(64);

const valid = (): IngestTurnV1 => ({
  v: 1,
  adapter: 'claude-code',
  adapterVersion: '0.1.0',
  idempotencyKey: hex('a'),
  sessionRef: hex('b'),
  sentAt: '2026-10-26T16:00:00.000Z',
  turnEndedAt: '2026-10-26T15:59:58.000+07:00',
  turn: {
    userPrompt: 'Giúp mình lập kế hoạch cuối tuần',
    assistantFinal: 'Đây là kế hoạch…',
    tools: [{ name: 'mcp__ai-unlocked__start_mission', ok: true, count: 1 }, { name: 'Bash', ok: false, count: 2 }],
    platform: { mcpTools: ['start_mission'], missionId: 'plan-weekend', runId: 'run_abc123' },
  },
  redaction: { count: 2, kinds: ['email', 'api_key'] },
  truncated: false,
  stopHookActive: false,
});

describe('ingestTurnV1Schema', () => {
  it('accepts the documented example, with or without platform', () => {
    expect(ingestTurnV1Schema.safeParse(valid()).success).toBe(true);
    const p = valid();
    delete p.turn.platform;
    p.turn.userPrompt = null;
    expect(ingestTurnV1Schema.safeParse(p).success).toBe(true);
  });

  it('rejects unknown fields at every level (no cwd, no file contents)', () => {
    expect(ingestTurnV1Schema.safeParse({ ...valid(), cwd: '/Users/x' }).success).toBe(false);
    const p = valid() as unknown as { turn: Record<string, unknown> };
    p.turn.files = ['a.ts'];
    expect(ingestTurnV1Schema.safeParse(p).success).toBe(false);
    const t = valid() as unknown as { turn: { tools: Array<Record<string, unknown>> } };
    t.turn.tools[0].input = 'rm -rf';
    expect(ingestTurnV1Schema.safeParse(t).success).toBe(false);
  });

  it('enforces version, adapter, hashes, timestamps and caps', () => {
    const bad: Array<(p: IngestTurnV1) => void> = [
      (p) => { (p as { v: number }).v = 2; },
      (p) => { (p as { adapter: string }).adapter = 'cursor'; },
      (p) => { p.adapterVersion = 'latest'; },
      (p) => { p.idempotencyKey = 'A'.repeat(64); },
      (p) => { p.sessionRef = 'raw-session-id'; },
      (p) => { p.sentAt = 'yesterday'; },
      (p) => { p.turn.userPrompt = 'x'.repeat(USER_PROMPT_MAX_CHARS + 1); },
      (p) => { p.turn.assistantFinal = 'x'.repeat(ASSISTANT_FINAL_MAX_CHARS + 1); },
      (p) => { p.turn.tools = Array.from({ length: TOOLS_MAX + 1 }, () => ({ name: 'Bash', ok: true, count: 1 })); },
      (p) => { p.turn.tools = [{ name: 'Bash $(id)', ok: true, count: 1 }]; },
      (p) => { p.turn.tools = [{ name: 'Bash', ok: true, count: 0 }]; },
      (p) => { p.turn.platform = { mcpTools: ['Start-Mission'] }; },
      (p) => { p.turn.platform = { mcpTools: [], runId: 'lrn_x' }; },
      (p) => { p.redaction = { count: -1, kinds: [] }; },
      (p) => { p.redaction = { count: 1, kinds: ['Email!'] }; },
    ];
    for (const [i, mutate] of bad.entries()) {
      const p = valid();
      mutate(p);
      expect(ingestTurnV1Schema.safeParse(p).success, `case ${i}`).toBe(false);
    }
  });

  it('accepts redaction kinds the server does not know yet', () => {
    const p = valid();
    p.redaction.kinds = ['future_kind'];
    expect(ingestTurnV1Schema.safeParse(p).success).toBe(true);
  });
});

describe('pairing', () => {
  it('normalises typed user codes', () => {
    expect(normalizeUserCode('abcd-efgh')).toBe('ABCD-EFGH');
    expect(normalizeUserCode(' wxyz 2345 ')).toBe('WXYZ-2345');
    expect(normalizeUserCode('ABCD-EFG')).toBeNull();
    expect(normalizeUserCode('ABCD-EFG0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeUserCode('ABCD-EFGI')).toBeNull(); // nor I
    expect(PAIR_USER_CODE_ALPHABET).not.toMatch(/[01IO]/);
  });

  it('validates start and poll bodies', () => {
    expect(pairStartSchema.safeParse({ label: 'MacBook của Lan', adapter: 'claude-code' }).success).toBe(true);
    expect(pairStartSchema.safeParse({ label: '', adapter: 'claude-code' }).success).toBe(false);
    expect(pairStartSchema.safeParse({ label: 'x'.repeat(65), adapter: 'claude-code' }).success).toBe(false);
    expect(pairPollSchema.safeParse({ deviceCode: 'A'.repeat(43) }).success).toBe(true);
    expect(pairPollSchema.safeParse({ deviceCode: 'short' }).success).toBe(false);
  });

  it('documents the ingest token format', () => {
    expect(INGEST_TOKEN_PATTERN.test(`aiu_ing_${'A'.repeat(43)}`)).toBe(true);
    expect(INGEST_TOKEN_PATTERN.test(`aiu_ing_${'A'.repeat(42)}`)).toBe(false);
  });
});

describe('helpers', () => {
  it('checks the sentAt window (±10 min)', () => {
    const now = new Date('2026-10-26T16:00:00.000Z');
    expect(sentAtWithinWindow('2026-10-26T16:09:59.000Z', now)).toBe(true);
    expect(sentAtWithinWindow('2026-10-26T15:50:00.000Z', now)).toBe(true);
    expect(sentAtWithinWindow('2026-10-26T16:10:01.000Z', now)).toBe(false);
    expect(sentAtWithinWindow('nope', now)).toBe(false);
  });

  it('counts UTF-8 bytes (Vietnamese diacritics are multi-byte)', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('ạ')).toBe(3);
  });

  it('builds error responses with the shared shape plus reason', async () => {
    const res = ingestError('consent_required', 'Bạn chưa bật phân tích.');
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: { code: 'forbidden', message: 'Bạn chưa bật phân tích.', reason: 'consent_required' } });
    expect(INGEST_ERROR_REASONS.feature_off.status).toBe(404);
    expect(INGEST_ERROR_REASONS.unauthorized.status).toBe(401);
  });
});
