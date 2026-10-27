/**
 * Active device tokens per learner are capped: minting past MAX_ACTIVE_TOKENS_PER_LEARNER revokes the
 * oldest active token (revoked_at, like a revoke from Settings), and the Settings list shows every active one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_ACTIVE_TOKENS_PER_LEARNER } from '../../src/lib/insights/ingest-contract';
import { createToken, listTokens, resolveToken } from '../../src/lib/insights/ingest-tokens';
import { count, makeEnv, NOW, seedMember, type TestEnv } from './insights-ingest-fixtures';

let t: TestEnv;
const minute = (n: number) => new Date(NOW.getTime() + n * 60_000);

beforeEach(async () => {
  t = makeEnv();
  await seedMember(t.db, 'lrn_a');
  await seedMember(t.db, 'lrn_b');
});

async function mint(learnerId: string, n: number, startMin = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const created = await createToken(t.db, learnerId, `Máy ${i}`, 'claude-code', minute(startMin + i));
    expect(created).not.toBeNull();
    out.push(created!);
  }
  return out;
}

describe('device token cap', () => {
  it('is 10', () => expect(MAX_ACTIVE_TOKENS_PER_LEARNER).toBe(10));

  it('pairing an 11th device revokes the oldest active token, which stops working', async () => {
    const tokens = await mint('lrn_a', MAX_ACTIVE_TOKENS_PER_LEARNER);
    expect(await listTokens(t.db, 'lrn_a', minute(20))).toHaveLength(10);

    const [newest] = await mint('lrn_a', 1, 30);
    const list = await listTokens(t.db, 'lrn_a', minute(31));
    expect(list).toHaveLength(10);
    expect(list[0].id).toBe(newest.id);
    expect(list.map((d) => d.id)).not.toContain(tokens[0].id);

    const oldest = await t.db.prepare('SELECT revoked_at FROM insight_tokens WHERE id = ?').bind(tokens[0].id).first<{ revoked_at: string }>();
    expect(oldest?.revoked_at).toBe(minute(30).toISOString());
    expect(await resolveToken(t.db, tokens[0].token, minute(31))).toBeNull();
    expect(await resolveToken(t.db, tokens[1].token, minute(31))).not.toBeNull();
    expect(await resolveToken(t.db, newest.token, minute(31))).not.toBeNull();
  });

  it('brings a learner already over the cap back to 10 and never touches another learner', async () => {
    await mint('lrn_b', 3);
    // Tokens minted before the cap existed.
    for (let i = 0; i < 13; i++) {
      await t.db.prepare(`INSERT INTO insight_tokens (id, learner_id, token_hash, label, adapter, created_at, expires_at)
        VALUES (?, 'lrn_a', ?, 'cũ', 'claude-code', ?, ?)`)
        .bind(`itk_old_${String(i).padStart(2, '0')}`, `hash_${i}`, minute(-100 + i).toISOString(), minute(60 * 24 * 90).toISOString()).run();
    }
    await mint('lrn_a', 1);
    expect(await listTokens(t.db, 'lrn_a', minute(1))).toHaveLength(10);
    expect(await count(t.db, `SELECT COUNT(*) AS n FROM insight_tokens WHERE learner_id = 'lrn_a' AND revoked_at IS NOT NULL`)).toBe(4);
    expect(await count(t.db, `SELECT COUNT(*) AS n FROM insight_tokens WHERE learner_id = 'lrn_a' AND revoked_at IS NOT NULL AND id >= 'itk_old_04'`)).toBe(0);
    expect(await listTokens(t.db, 'lrn_b', minute(1))).toHaveLength(3);
  });

  it('expired and revoked tokens do not count toward the cap', async () => {
    await t.db.prepare(`INSERT INTO insight_tokens (id, learner_id, token_hash, label, adapter, created_at, expires_at, revoked_at)
      VALUES ('itk_rev', 'lrn_a', 'h_rev', 'x', 'claude-code', ?, ?, ?), ('itk_exp', 'lrn_a', 'h_exp', 'x', 'claude-code', ?, ?, NULL)`)
      .bind(minute(-50).toISOString(), minute(9999).toISOString(), minute(-40).toISOString(), minute(-60).toISOString(), minute(-1).toISOString()).run();
    await mint('lrn_a', MAX_ACTIVE_TOKENS_PER_LEARNER);
    expect(await count(t.db, `SELECT COUNT(*) AS n FROM insight_tokens WHERE revoked_at IS NULL AND learner_id = 'lrn_a' AND id LIKE 'itk_%' AND id NOT IN ('itk_exp')`)).toBe(10);
    const rev = await t.db.prepare(`SELECT revoked_at FROM insight_tokens WHERE id = 'itk_rev'`).first<{ revoked_at: string }>();
    expect(rev?.revoked_at).toBe(minute(-40).toISOString());
  });

  it('a learner who can no longer hold a token gets none, and nothing is revoked', async () => {
    const tokens = await mint('lrn_a', MAX_ACTIVE_TOKENS_PER_LEARNER);
    await t.db.prepare(`UPDATE learners SET deleted_at = ? WHERE id = 'lrn_a'`).bind(NOW.toISOString()).run();
    expect(await createToken(t.db, 'lrn_a', 'x', 'claude-code', minute(30))).toBeNull();
    expect(await count(t.db, `SELECT COUNT(*) AS n FROM insight_tokens WHERE revoked_at IS NOT NULL`)).toBe(0);
    expect(tokens).toHaveLength(10);
  });

  it('the Settings copy states the same cap', () => {
    const panel = readFileSync(join(process.cwd(), 'src/components/settings/InsightsSettingsPanel.tsx'), 'utf8');
    expect(panel).toContain(`Tối đa ${MAX_ACTIVE_TOKENS_PER_LEARNER} thiết bị.`);
  });
});
