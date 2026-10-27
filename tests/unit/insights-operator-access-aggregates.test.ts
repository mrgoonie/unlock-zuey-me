import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import {
  COHORT_MIN, learningPatterns, pipelineHealth, productSignals, saigonDayStart,
} from '../../src/lib/insights/operator-insight-queries';

let db: D1Database;
const NOW = new Date('2026-10-26T05:00:00.000Z'); // 12:00 in Asia/Saigon
const T = '2026-10-25T03:00:00.000Z';
/** When the fixtures' proposals consent was granted: before every report written at T. */
const PROPOSALS_AT = '2026-10-24T00:00:00.000Z';

/** Account creation of established fixtures: well over 7 days before the reports, with a mission completed then. */
const JOINED = '2026-09-25T03:00:00.000Z';

async function learner(id: string, consents: { analysis: boolean; proposals?: boolean }, o: { established?: boolean } = {}) {
  const established = o.established ?? true;
  await db.batch([
    db.prepare(`INSERT INTO learners (id, kind, display_name, email, profile_json, created_at, updated_at)
      VALUES (?, 'member', ?, ?, '{}', ?, ?)`).bind(id, `Tên riêng ${id}`, `${id}@example.com`, established ? JOINED : T, T),
    ...(established ? [db.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, answers_json, started_at, updated_at, completed_at)
      VALUES (?, ?, 'plan-weekend', 1, 'completed', '{}', ?, ?, ?)`).bind(`run_done_${id}`, id, JOINED, JOINED, JOINED)] : []),
    db.prepare(`INSERT INTO insight_consents (learner_id, analysis, share_operator, proposals, proposals_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`)
      .bind(id, consents.analysis ? 1 : 0, consents.proposals ? 1 : 0, consents.proposals ? PROPOSALS_AT : null, T),
  ]);
}

async function report(id: string, learnerId: string, o: { skills: string[]; gaps?: number; risk?: string; nextMission?: string; runStatus?: string; useful?: 0 | 1 }) {
  const runId = o.runStatus ? `run_${id}` : null;
  if (runId) {
    await db.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, answers_json, started_at, updated_at)
      VALUES (?, ?, 'plan-weekend', 1, ?, '{}', ?, ?)`).bind(runId, learnerId, o.runStatus, T, T).run();
  }
  const json = {
    relevant: true,
    intent_summary: { text: `Văn bản riêng tư ${learnerId}`, confidence: 0.7 },
    verification_gaps: Array.from({ length: o.gaps ?? 0 }, () => ({ note: 'gap', evidence_ref: 'e1' })),
    risk_signals: o.risk ? [{ kind: o.risk, note: 'note', evidence_ref: 'e1' }] : [],
    next_best_action: o.nextMission ? { text: 'tiếp', mission_id: o.nextMission } : null,
  };
  await db.prepare(`INSERT INTO insight_reports (id, learner_id, session_ref, run_id, report_json, intent_summary, skills_json, confidence, source_runtime,
      model, prompt_version, event_count, useful, window_started_at, window_ended_at, created_at, expires_at)
    VALUES (?, ?, 'sref', ?, ?, ?, ?, 0.7, 'claude-code', 'm', 1, 1, ?, ?, ?, ?, '2099-01-01T00:00:00.000Z')`)
    .bind(id, learnerId, runId, JSON.stringify(json), `Văn bản riêng tư ${learnerId}`, JSON.stringify(o.skills), o.useful ?? null, T, T, T).run();
}

async function signal(id: string, title: string, reportIds: string[]) {
  await db.prepare(`INSERT INTO insight_signals (id, fingerprint, category, area, title, first_seen_at, last_seen_at, created_at)
    VALUES (?, ?, 'ux', 'mcp', ?, ?, ?, ?)`).bind(id, `fp_${id}`, title, T, T, T).run();
  for (const r of reportIds) {
    await db.prepare(`INSERT INTO insight_signal_evidence (signal_id, report_id, abstract_evidence, confidence, created_at) VALUES (?, ?, 'abstract', 0.8, ?)`)
      .bind(id, r, T).run();
  }
}

beforeEach(async () => {
  db = createTestD1();
  await learner('lrn_1', { analysis: true, proposals: true });
  await learner('lrn_2', { analysis: true, proposals: true });
  await learner('lrn_3', { analysis: true, proposals: true });
  await learner('lrn_4', { analysis: true, proposals: false });
  await learner('lrn_5', { analysis: false, proposals: false });
  // verify: 3 consenting learners → shown. describe: 2 consenting + 1 without analysis → suppressed.
  await report('r1', 'lrn_1', { skills: ['verify', 'describe'], gaps: 1, risk: 'unverified_claim', nextMission: 'plan-weekend', runStatus: 'completed', useful: 1 });
  await report('r2', 'lrn_2', { skills: ['verify', 'describe'], gaps: 0, risk: 'unverified_claim', nextMission: 'plan-weekend', runStatus: 'completed', useful: 0 });
  await report('r3', 'lrn_3', { skills: ['verify'], gaps: 2, risk: 'unverified_claim', nextMission: 'plan-weekend', runStatus: 'completed' });
  await report('r4', 'lrn_4', { skills: ['delegate'], risk: 'overreliance', runStatus: 'started' });
  await report('r5', 'lrn_5', { skills: ['describe', 'delegate'], risk: 'overreliance', runStatus: 'started' });
});

describe('learning patterns (k-anonymity)', () => {
  it(`shows buckets with ≥ ${COHORT_MIN} consenting learners and suppresses smaller ones`, async () => {
    const p = await learningPatterns(db, NOW);
    expect(p.skills).toEqual([{ key: 'verify', reports: 3, learners: 3 }]);
    expect(p.riskKinds).toEqual([{ key: 'unverified_claim', reports: 3, learners: 3 }]);
    expect(p.nextMissions).toEqual([{ key: 'plan-weekend', reports: 3, learners: 3 }]);
    expect(p.taskOutcomes).toEqual([{ key: 'completed', reports: 3, learners: 3 }]);
    // lrn_5 has no analysis consent, so only lrn_1..4 count.
    expect(p.verificationGap).toEqual({ reports: 4, withGaps: 2, learners: 4 });
  });

  it('a cohort of 2 is suppressed entirely', async () => {
    await db.prepare('UPDATE insight_consents SET analysis = 0 WHERE learner_id IN (?, ?)').bind('lrn_3', 'lrn_4').run();
    const p = await learningPatterns(db, NOW);
    expect(p.skills).toEqual([]);
    expect(p.riskKinds).toEqual([]);
    expect(p.nextMissions).toEqual([]);
    expect(p.taskOutcomes).toEqual([]);
    expect(p.verificationGap).toBeNull();
  });

  it('a corrupt report row does not break the aggregates', async () => {
    await db.prepare(`UPDATE insight_reports SET report_json = 'not json', skills_json = '{' WHERE id = 'r4'`).run();
    const p = await learningPatterns(db, NOW);
    expect(p.skills.map((b) => b.key)).toEqual(['verify']);
  });
});

describe('product signals', () => {
  it('counts only evidence from proposals-consenting learners, with k ≥ 3', async () => {
    await signal('sig_ok', 'Nút bắt đầu mission khó thấy', ['r1', 'r2', 'r3']);
    await signal('sig_small', 'Gợi ý quá dài', ['r1', 'r2', 'r4']); // lrn_4 has proposals = 0
    const rows = await productSignals(db);
    expect(rows.map((r) => r.id)).toEqual(['sig_ok']);
    expect(rows[0]).toMatchObject({ title: 'Nút bắt đầu mission khó thấy', occurrences: 3, affectedLearners: 3, proposalStatus: null });
  });

  it('counts no evidence from reports written before the proposals consent was granted', async () => {
    await signal('sig_ok', 'Nút bắt đầu mission khó thấy', ['r1', 'r2', 'r3']);
    expect(await productSignals(db)).toHaveLength(1);
    // lrn_3 turned proposals off and on again after r3 was written: r3 is no longer consented evidence.
    await db.prepare(`UPDATE insight_consents SET proposals_at = ? WHERE learner_id = 'lrn_3'`).bind('2026-10-25T04:00:00.000Z').run();
    expect(await productSignals(db)).toEqual([]);
    // A consent row with proposals = 1 but no grant time counts nothing either.
    await db.prepare(`UPDATE insight_consents SET proposals_at = NULL WHERE learner_id = 'lrn_3'`).run();
    expect(await productSignals(db)).toEqual([]);
  });

  it('counts no evidence from new accounts or learners without a completed mission', async () => {
    await signal('sig_ok', 'Nút bắt đầu mission khó thấy', ['r1', 'r2', 'r3']);
    expect(await productSignals(db)).toHaveLength(1);
    // lrn_3's account is younger than 7 days when r3 was written.
    await db.prepare(`UPDATE learners SET created_at = ? WHERE id = 'lrn_3'`).bind('2026-10-20T00:00:00.000Z').run();
    expect(await productSignals(db)).toEqual([]);
    // Old enough again, but without any completed mission.
    await db.prepare(`UPDATE learners SET created_at = ? WHERE id = 'lrn_3'`).bind(JOINED).run();
    await db.prepare(`DELETE FROM mission_runs WHERE learner_id = 'lrn_3' AND status = 'completed'`).run();
    expect(await productSignals(db)).toEqual([]);
  });

  it('includes the proposal status when one exists', async () => {
    await signal('sig_ok', 'Nút bắt đầu mission khó thấy', ['r1', 'r2', 'r3']);
    await db.prepare(`INSERT INTO insight_proposals (id, signal_id, status, risk, gate_json, draft_json, created_at, updated_at)
      VALUES ('prp_1', 'sig_ok', 'issue_filed', 'low', '{}', '{}', ?, ?)`).bind(T, T).run();
    await db.prepare(`UPDATE insight_proposals SET github_issue_number = 42, github_issue_url = 'https://github.com/x/y/issues/42'`).run();
    const [row] = await productSignals(db);
    expect(row).toMatchObject({ proposalStatus: 'issue_filed', issueNumber: 42 });
  });
});

describe('pipeline health', () => {
  it('counts today (Asia/Saigon) and the last 7 days, plus the current queue', async () => {
    const ev = (id: string, status: string, receivedAt: string, extra: { skip?: string; attempts?: number; next?: string } = {}) =>
      db.prepare(`INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_bytes,
          status, skip_reason, attempts, next_attempt_at, turn_ended_at, received_at)
        VALUES (?, 'lrn_1', ?, 'sref', 'claude-code', '0.1.0', 10, ?, ?, ?, ?, ?, ?)`)
        .bind(id, `k_${id}`, status, extra.skip ?? null, extra.attempts ?? 0, extra.next ?? receivedAt, receivedAt, receivedAt).run();
    await ev('e1', 'pending', '2026-10-26T01:00:00.000Z', { next: '2026-10-26T01:05:00.000Z' });
    await ev('e2', 'pending', '2026-10-26T01:00:00.000Z', { next: '2026-10-26T01:30:00.000Z' }); // deferred by budget
    await ev('e3', 'skipped', '2026-10-26T02:00:00.000Z', { skip: 'trivial' });
    await ev('e4', 'dead', '2026-10-22T02:00:00.000Z', { attempts: 4 });
    await ev('e5', 'skipped', '2026-10-21T02:00:00.000Z', { skip: 'not_learning' });
    await ev('e6', 'done', '2026-10-25T16:30:00.000Z'); // 23:30 on 25/10 in Saigon: not today
    const h = await pipelineHealth(db, NOW);
    expect(saigonDayStart(NOW)).toBe('2026-10-25T17:00:00.000Z');
    expect(h.today).toMatchObject({ received: 3, dead: 0, skipped: { trivial: 1 } });
    expect(h.week).toMatchObject({ received: 6, dead: 1, skipped: { trivial: 1, not_learning: 1 }, analysed: 5, rated: 2, usefulRate: 0.5 });
    expect(h).toMatchObject({ pending: 2, processing: 0, budgetDeferred: 1 });
  });
});

describe('aggregates carry no personal data', () => {
  it('never contains learner ids, names, emails or report text', async () => {
    await signal('sig_ok', 'Nút bắt đầu mission khó thấy', ['r1', 'r2', 'r3']);
    const out = JSON.stringify([await pipelineHealth(db, NOW), await learningPatterns(db, NOW), await productSignals(db)]);
    for (const leak of ['lrn_', 'Tên riêng', '@example.com', 'Văn bản riêng tư', 'abstract']) expect(out).not.toContain(leak);
  });
});
