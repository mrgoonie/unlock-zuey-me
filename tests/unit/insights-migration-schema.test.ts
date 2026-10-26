/**
 * Insights schema (migrations/0008_insights.sql): tables, unique keys, CHECKs, cascades, and privacy
 * registry coverage so export and delete include every new learner-owned table.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkMigrationSql } from '../../scripts/migration-safety-rules';
import { deleteLearnerData } from '../../src/lib/privacy/delete-learner-data';
import { exportLearnerTablePage } from '../../src/lib/privacy/export-learner-data';
import { LEARNER_TABLES } from '../../src/lib/privacy/learner-data-tables';
import { createTestD1 } from '../helpers/d1-sqlite';
import { fakeBucket, seedLearner, T0 } from './observer-seed-fixtures';

const INSIGHT_TABLES = [
  'insight_access_audit', 'insight_consents', 'insight_events', 'insight_operator_settings', 'insight_proposals',
  'insight_reports', 'insight_signal_evidence', 'insight_signals', 'insight_tokens',
];
const LEARNER_OWNED = ['insight_access_audit', 'insight_consents', 'insight_events', 'insight_reports', 'insight_tokens'];

let db: D1Database;

beforeEach(async () => {
  db = createTestD1();
  await seedLearner(db, 'lrn_a', { consent: true });
  await seedLearner(db, 'lrn_b', { consent: false });
});

const run = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run();
const count = async (sql: string, ...binds: unknown[]) => Number(await db.prepare(sql).bind(...binds).first('n'));

async function addSignal(id: string, fingerprint: string) {
  await run(`INSERT INTO insight_signals (id, fingerprint, category, area, title, first_seen_at, last_seen_at, created_at)
    VALUES (?, ?, 'content', 'mission:plan-weekend', 'Giải thích chưa rõ', ?, ?, ?)`, id, fingerprint, T0, T0, T0);
}

describe('0008_insights migration', () => {
  it('passes the additive-only migration guard', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'migrations', '0008_insights.sql'), 'utf8');
    expect(checkMigrationSql('0008_insights.sql', sql)).toEqual([]);
  });

  it('creates every insights table', async () => {
    const r = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'insight_%' ORDER BY name`).all<{ name: string }>();
    expect(r.results.map((x) => x.name)).toEqual(INSIGHT_TABLES);
  });

  it('dedupes queue rows per (learner, idempotency key) but not across learners', async () => {
    const insert = (id: string, learner: string, key: string) => run(
      `INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json, payload_bytes,
        next_attempt_at, turn_ended_at, received_at) VALUES (?, ?, ?, 's', 'claude-code', '0.1.0', '{}', 2, ?, ?, ?)`,
      id, learner, key, T0, T0, T0,
    );
    await insert('iev_1', 'lrn_a', 'k');
    await expect(insert('iev_2', 'lrn_a', 'k')).rejects.toThrow(/UNIQUE/);
    await expect(insert('iev_3', 'lrn_b', 'k')).resolves.toBeTruthy();
    const row = await db.prepare(`SELECT status, attempts, redactions FROM insight_events WHERE id = 'iev_1'`).first();
    expect(row).toEqual({ status: 'pending', attempts: 0, redactions: 0 });
  });

  it('enforces CHECK constraints', async () => {
    await expect(run(`UPDATE insight_consents SET analysis = 2 WHERE learner_id = 'lrn_a'`)).rejects.toThrow(/CHECK/);
    await expect(run(`UPDATE insight_events SET status = 'lost' WHERE learner_id = 'lrn_a'`)).rejects.toThrow(/CHECK/);
    await expect(run(`UPDATE insight_reports SET confidence = 1.5 WHERE learner_id = 'lrn_a'`)).rejects.toThrow(/CHECK/);
    await expect(run(`UPDATE insight_reports SET useful = 3 WHERE learner_id = 'lrn_a'`)).rejects.toThrow(/CHECK/);
    await expect(run(`UPDATE insight_tokens SET scope = 'learn:write' WHERE learner_id = 'lrn_a'`)).rejects.toThrow(/CHECK/);
    await expect(run(`INSERT INTO insight_signals (id, fingerprint, category, area, title, first_seen_at, last_seen_at, created_at)
      VALUES ('sig_x', 'fp_x', 'personal_preference', 'other', 't', ?, ?, ?)`, T0, T0, T0)).rejects.toThrow(/CHECK/);
    await addSignal('sig_1', 'fp_1');
    const proposal = (id: string, signal: string, status: string, risk: string) => run(
      `INSERT INTO insight_proposals (id, signal_id, status, risk, gate_json, draft_json, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', '{}', ?, ?)`,
      id, signal, status, risk, T0, T0,
    );
    await expect(proposal('prp_x', 'sig_1', 'merged', 'low')).rejects.toThrow(/CHECK/);
    await expect(proposal('prp_y', 'sig_1', 'proposed', 'critical')).rejects.toThrow(/CHECK/);
  });

  it('keeps tokens unique by hash and signals unique by fingerprint, with one proposal per signal', async () => {
    await expect(run(`INSERT INTO insight_tokens (id, learner_id, token_hash, label, adapter, created_at, expires_at)
      VALUES ('itk_dup', 'lrn_b', 'ihash_lrn_a', 'x', 'claude-code', ?, ?)`, T0, T0)).rejects.toThrow(/UNIQUE/);
    await addSignal('sig_1', 'fp_1');
    await expect(addSignal('sig_2', 'fp_1')).rejects.toThrow(/UNIQUE/);
    const proposal = (id: string) => run(
      `INSERT INTO insight_proposals (id, signal_id, status, risk, gate_json, draft_json, created_at, updated_at) VALUES (?, 'sig_1', 'proposed', 'low', '{}', '{}', ?, ?)`,
      id, T0, T0,
    );
    await proposal('prp_1');
    await expect(proposal('prp_2')).rejects.toThrow(/UNIQUE/);
  });

  it('cascades signal evidence when its report is deleted, keeping the de-identified signal', async () => {
    await addSignal('sig_1', 'fp_1');
    await run(`INSERT INTO insight_signal_evidence (signal_id, report_id, abstract_evidence, confidence, created_at) VALUES ('sig_1', 'irp_lrn_a', 'Bước 2 thiếu ví dụ', 0.8, ?)`, T0);
    await run(`INSERT INTO insight_signal_evidence (signal_id, report_id, abstract_evidence, confidence, created_at) VALUES ('sig_1', 'irp_lrn_b', 'Bước 2 thiếu ví dụ', 0.7, ?)`, T0);
    await expect(run(`INSERT INTO insight_signal_evidence (signal_id, report_id, abstract_evidence, confidence, created_at)
      VALUES ('sig_1', 'irp_lrn_a', 'again', 0.8, ?)`, T0)).rejects.toThrow(/UNIQUE|PRIMARY/);
    await run(`DELETE FROM insight_reports WHERE id = 'irp_lrn_a'`);
    expect(await count(`SELECT COUNT(*) AS n FROM insight_signal_evidence WHERE report_id = 'irp_lrn_a'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM insight_signal_evidence WHERE report_id = 'irp_lrn_b'`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM insight_signals`)).toBe(1);
  });

  it('has no learner column on de-identified tables', async () => {
    for (const t of ['insight_signals', 'insight_signal_evidence', 'insight_proposals', 'insight_operator_settings']) {
      const cols = await db.prepare(`SELECT name FROM pragma_table_info(?)`).bind(t).all<{ name: string }>();
      expect(cols.results.map((c) => c.name), t).not.toContain('learner_id');
    }
  });
});

describe('insights privacy registry', () => {
  it('registers all five learner-owned insights tables before ai_usage, hiding token hashes from export', () => {
    const names = LEARNER_TABLES.map((t) => t.table);
    for (const t of LEARNER_OWNED) {
      expect(names, t).toContain(t);
      expect(names.indexOf(t), t).toBeLessThan(names.indexOf('ai_usage'));
    }
    expect(LEARNER_TABLES.find((t) => t.table === 'insight_tokens')?.omitFromExport).toEqual(['token_hash']);
  });

  it('exports the learner\'s insights rows without the token hash and without anyone else\'s rows', async () => {
    for (const t of LEARNER_OWNED) {
      const page = await exportLearnerTablePage(db, 'lrn_a', t, 0);
      expect(page.rows.length, t).toBe(1);
      expect(JSON.stringify(page.rows), t).not.toContain('lrn_b');
    }
    const tokens = await exportLearnerTablePage(db, 'lrn_a', 'insight_tokens', 0);
    expect(tokens.rows[0]).not.toHaveProperty('token_hash');
    expect(tokens.rows[0]).toMatchObject({ label: 'MacBook', adapter: 'claude-code' });
  });

  it('deletes the learner\'s insights rows and their signal evidence, leaving other learners intact', async () => {
    await addSignal('sig_1', 'fp_1');
    for (const r of ['irp_lrn_a', 'irp_lrn_b']) {
      await run(`INSERT INTO insight_signal_evidence (signal_id, report_id, abstract_evidence, confidence, created_at) VALUES ('sig_1', ?, 'x', 0.8, ?)`, r, T0);
    }
    const oauth = { async listUserGrants() { return { items: [] }; }, async revokeGrant() {} };
    await deleteLearnerData(db, fakeBucket([]).bucket, 'lrn_a', oauth);
    for (const t of LEARNER_OWNED) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE learner_id = 'lrn_a'`), t).toBe(0);
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE learner_id = 'lrn_b'`), t).toBe(1);
    }
    expect(await count(`SELECT COUNT(*) AS n FROM insight_signal_evidence`)).toBe(1);
  });
});
