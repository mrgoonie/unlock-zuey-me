/**
 * The whole insights chain in one process, on the real schema, with a mocked model and GitHub off:
 * consent (web) → device pairing → client payload (the skill's turn-payload.mjs) → POST /api/ingest/v1/turns
 * → cron pipeline (retention → ai-tutor analyzer → proposal stage) → learner reports API → admin proposals
 * and operator summary APIs.
 *
 * Four learners: alpha, bravo and delta allow `proposals`, charlie allows analysis only. Every hop is scanned for
 * the seeded secrets, and charlie's text must never reach anything that feeds proposals. Also covered: a
 * revoke before the tick and during the model call (no report), and a duplicate Stop (one event).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTurnPayload } from '../../skills/ai-unlocked/scripts/lib/turn-payload.mjs';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { runAnalyzerStage } from '../../src/lib/insights/analyzer-stage';
import { runInsightsPipeline, type InsightsPipelineStages } from '../../src/lib/insights/pipeline-job';
import { runProposalStage } from '../../src/lib/insights/proposal-stage';
import { runRetentionStage } from '../../src/lib/insights/retention-stage';
import type { InsightsPipelineResult } from '../../src/lib/insights/insight-types';
import type { LearnerContext } from '../../src/lib/learning/types';
import { POST as pairStartRoute } from '../../src/pages/api/ingest/v1/pair/start';
import { POST as pairPollRoute } from '../../src/pages/api/ingest/v1/pair/poll';
import { POST as turnsRoute } from '../../src/pages/api/ingest/v1/turns';
import { PATCH as consentRoute } from '../../src/pages/api/v1/insights/consent';
import { POST as pairConfirmRoute } from '../../src/pages/api/v1/insights/pair/confirm';
import { GET as reportsRoute } from '../../src/pages/api/v1/insights/reports/index';
import { GET as summaryRoute } from '../../src/pages/api/v1/admin/insights/summary';
import { GET as proposalsRoute } from '../../src/pages/api/v1/admin/insights/proposals/index';
import { GET as proposalDetailRoute } from '../../src/pages/api/v1/admin/insights/proposals/[id]';
import { GET as automationRoute } from '../../src/pages/api/v1/admin/insights/settings';
import { callRoute, ingestRequest, memoryKv, NOW, sha, SITE } from './insights-ingest-fixtures';
import { fakeGithub, stubModel } from './insights-proposal-stage-fixtures';
import { fakeEnv, openRouterFetch, type FakeEnv } from './learning-fake-env';
import { learnerCtx } from './observer-seed-fixtures';
import { resetFallbackLimiter } from '../../src/lib/identity/request-rate-limits';

// Secrets a learner might paste into Claude Code. None may survive past the device.
const SECRETS = {
  apiKey: `sk-ant-api03-${'a1B2c3D4'.repeat(6)}`,
  email: 'duy.nguyen.private@example.com',
  phone: '0912345678',
  github: `ghp_${'Z9y8X7w6V5'.repeat(4)}`,
};
const SECRET_VALUES = Object.values(SECRETS);

const LEARNERS = ['alpha', 'bravo', 'charlie', 'delta'] as const;
type Name = (typeof LEARNERS)[number];
const idOf = (n: Name) => `lrn_${n}`;
const ctxOf = (n: Name): LearnerContext => learnerCtx(idOf(n));
const ADMIN = learnerCtx('lrn_admin', { isAdmin: true, email: 'admin@example.com' });

let env: FakeEnv;
let tokens: Record<Name, string>;

const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;

/** Fails with the offending hop when any seeded secret (or extra forbidden text) appears in `value`. */
function expectClean(hop: string, value: unknown, extra: string[] = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of [...SECRET_VALUES, ...extra]) expect(text.includes(s), `${hop} contains "${s}"`).toBe(false);
}

const sessionRoute = (route: (c: never) => Response | Promise<Response>, learner: LearnerContext, path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) =>
  callRoute(route, env, new Request(`${SITE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }), { learner, params: opts.params });

/** An established member (30-day-old account with a completed mission), so their reports count toward proposals. */
async function seedMember(n: Name) {
  const ts = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await env.DB.prepare(`INSERT INTO learners (id, kind, display_name, email, profile_json, created_at, updated_at) VALUES (?, 'member', ?, ?, '{}', ?, ?)`)
    .bind(idOf(n), `Học viên ${n}`, `${idOf(n)}@example.com`, ts, ts).run();
  await env.DB.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, started_at, updated_at, completed_at)
    VALUES (?, ?, 'plan-weekend', 1, 'completed', ?, ?, ?)`).bind(`run_${idOf(n)}`, idOf(n), ts, ts, ts).run();
}

/** The learner flips consents in Settings (PATCH /api/v1/insights/consent). */
async function setConsent(n: Name, consents: { analysis?: boolean; proposals?: boolean }) {
  const res = await sessionRoute(consentRoute, ctxOf(n), '/api/v1/insights/consent', { method: 'PATCH', body: consents });
  expect(res.status).toBe(200);
}

/** `ai-unlocked pair`: start on the device, approve on /insights/pair, poll once for the token. */
async function pair(n: Name): Promise<string> {
  const start = await json<{ deviceCode: string; userCode: string }>(callRoute(pairStartRoute, env,
    ingestRequest('/api/ingest/v1/pair/start', { body: { label: `Máy của ${n}`, adapter: 'claude-code' } })));
  const confirm = await sessionRoute(pairConfirmRoute, ctxOf(n), '/api/v1/insights/pair/confirm', {
    method: 'POST', body: { userCode: start.userCode, approve: true },
  });
  expect(confirm.status).toBe(200);
  advance(5_000);
  const poll = await callRoute(pairPollRoute, env, ingestRequest('/api/ingest/v1/pair/poll', { body: { deviceCode: start.deviceCode } }));
  expect(poll.status).toBe(200);
  return ((await poll.json()) as { token: string }).token;
}

/**
 * What the Stop hook spools for one turn: the skill's own payload builder (client-side redaction) fed with a
 * prompt and a final reply that both contain every secret. Each learner's text carries their name, so the
 * mock model can echo it into the product observation and we can trace where each learner's text travels.
 */
function devicePayload(n: Name, prompt = 1) {
  const leak = `key ${SECRETS.apiKey}, mail ${SECRETS.email}, gọi ${SECRETS.phone}, token ${SECRETS.github}`;
  return buildTurnPayload({
    input: {
      session_id: `session-${n}`,
      prompt_id: `prompt-${prompt}`,
      last_assistant_message: `Mình đã bắt đầu mission lập kế hoạch cuối tuần cho ${n}. Bước 2 cần bạn liệt kê ràng buộc. (${leak})`,
    },
    window: {
      userPrompt: `Mình là ${n}, gợi ý ở bước 2 của mission cuối tuần khó hiểu quá, giải thích giúp mình. ${leak}`,
      tools: [{ name: 'mcp__ai-unlocked__start_mission', ok: true, count: 1 }],
      platform: { mcpTools: ['start_mission'], missionId: 'plan-weekend' },
      parsed: true,
    },
    installSalt: `salt-${n}`,
    now: new Date(),
  });
}

const postTurn = (n: Name, body: unknown) =>
  callRoute(turnsRoute, env, ingestRequest('/api/ingest/v1/turns', { token: tokens[n], body }));

/** The model answer for one window: valid report whose product observation names the learner found in the prompt. */
function modelReport(body: Record<string, unknown>): string {
  const user = JSON.stringify(body.messages);
  const who = LEARNERS.find((n) => user.includes(`Mình là ${n}`)) ?? 'unknown';
  return JSON.stringify({
    relevant: true,
    intent_summary: { text: 'Bạn nhờ AI giải thích gợi ý bước 2 của mission cuối tuần.', confidence: 0.8 },
    workflow_observed: [{ step: 'Mở mission qua MCP rồi hỏi về gợi ý', evidence_ref: 'e1' }],
    learning_insights: [{ skill: 'describe', note: 'Bạn nói rõ bước nào đang vướng.' }],
    verification_gaps: [],
    risk_signals: [],
    next_best_action: { text: 'Thử viết lại ràng buộc theo ví dụ.', mission_id: 'plan-weekend' },
    product_observation: {
      category: 'content', area: 'mission:plan-weekend', topic_key: 'step-2-hint-unclear',
      summary: `Gợi ý bước 2 của mission cuối tuần khó hiểu với người mới (${who}).`, evidence_ref: 'e1', confidence: 0.8,
    },
    confidence: 0.8,
  });
}

/** One cron tick of the real pipeline job, with the model and GitHub transports mocked. */
function stages(fetchImpl: typeof fetch, gh: ReturnType<typeof fakeGithub>, draft: ReturnType<typeof stubModel>): InsightsPipelineStages {
  return {
    retention: runRetentionStage,
    analyzer: (e, b, now) => runAnalyzerStage(e, b, now, { fetchImpl }),
    proposal: (e, b, now) => runProposalStage(e, b, now, { fetchImpl: gh.fetchImpl, draftModel: draft.model }),
  };
}

const tick = (s: InsightsPipelineStages): Promise<InsightsPipelineResult> => runInsightsPipeline(env, createCronBudget(), new Date(), s);

async function dumpTables(): Promise<Record<string, unknown[]>> {
  const tables = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%'`)
    .all<{ name: string }>();
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables.results) out[name] = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
  return out;
}

const rows = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>().then((r) => r.results);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetFallbackLimiter();
  env = fakeEnv({
    CACHE: memoryKv(() => Date.now()).kv, INSIGHTS_MODE: 'on', ADMIN_EMAILS: 'admin@example.com',
    INSIGHTS_GITHUB_ISSUES: undefined, GITHUB_ISSUES_TOKEN: undefined,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const n of LEARNERS) await seedMember(n);
  await setConsent('alpha', { analysis: true, proposals: true });
  await setConsent('bravo', { analysis: true, proposals: true });
  await setConsent('charlie', { analysis: true });
  await setConsent('delta', { analysis: true, proposals: true });
  tokens = { alpha: await pair('alpha'), bravo: await pair('bravo'), charlie: await pair('charlie'), delta: await pair('delta') };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('insights pipeline end to end (mock AI, GitHub off)', () => {
  it('carries three learners from the Stop hook payload to reports, a proposal and the operator summary, redacting at every hop', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');

    // Hop 1, device: the spooled payload is already redacted by the skill.
    const payloads = Object.fromEntries(LEARNERS.map((n) => [n, devicePayload(n)])) as Record<Name, ReturnType<typeof devicePayload>>;
    for (const n of LEARNERS) {
      expectClean(`device payload of ${n}`, payloads[n]);
      expect(payloads[n].redaction.count).toBeGreaterThanOrEqual(8);
    }
    // bravo runs an outdated client that skipped redaction: the server must catch it.
    const unredacted = { ...payloads.bravo, turn: { ...payloads.bravo.turn, userPrompt: `Mình là bravo, gợi ý bước 2 khó hiểu. ${SECRET_VALUES.join(' ')}` } };
    expect(JSON.stringify(unredacted)).toContain(SECRETS.apiKey);

    // Hop 2, ingest: 202 for each, a duplicate Stop is answered duplicate:true and stored once.
    expect(await json(postTurn('alpha', payloads.alpha))).toEqual({ accepted: true, duplicate: false });
    expect(await json(postTurn('alpha', payloads.alpha))).toEqual({ accepted: true, duplicate: true });
    expect(await json(postTurn('bravo', unredacted))).toEqual({ accepted: true, duplicate: false });
    expect(await json(postTurn('charlie', payloads.charlie))).toEqual({ accepted: true, duplicate: false });
    expect(await json(postTurn('delta', payloads.delta))).toEqual({ accepted: true, duplicate: false });
    const queued = await rows(`SELECT learner_id, status, payload_json, redactions FROM insight_events ORDER BY learner_id`);
    expect(queued.map((e) => [e.learner_id, e.status])).toEqual([['lrn_alpha', 'pending'], ['lrn_bravo', 'pending'], ['lrn_charlie', 'pending'], ['lrn_delta', 'pending']]);
    expectClean('queued payloads', queued);
    expect(String(queued[1].payload_json)).toContain('[REDACTED:api_key]');

    // Tick 1, before the 5-minute debounce: nothing is analysed and the model is not called.
    const model = openRouterFetch(modelReport);
    const gh = fakeGithub();
    const draft = stubModel();
    let result = await tick(stages(model.fetchImpl, gh, draft));
    expect(result).toMatchObject({ mode: 'on', analyzer: { status: 'ok', result: { analysed: 0, aiCalls: 0 } } });
    expect(model.calls).toHaveLength(0);

    // Tick 2, after the debounce: one model call per learner window, then reports; the reports are too fresh to link yet.
    advance(6 * 60_000);
    result = await tick(stages(model.fetchImpl, gh, draft));
    expect(result).toMatchObject({
      analyzer: { status: 'ok', result: { analysed: 4, aiCalls: 4, failed: 0, dead: 0, revoked: 0 } },
      proposal: { status: 'ok', result: { linked: 0, proposalsCreated: 0, githubMode: 'off' } },
    });
    // Hop 3, model input: redacted text only, fenced, no tools.
    expect(model.calls).toHaveLength(4);
    for (const call of model.calls) {
      expectClean('model request', call.body);
      expect(JSON.stringify(call.body)).toContain('[REDACTED:');
      expect(call.body.tools).toBeUndefined();
    }
    const events = await rows(`SELECT status, payload_json, report_id FROM insight_events`);
    expect(events.every((e) => e.status === 'done' && e.payload_json === null && typeof e.report_id === 'string')).toBe(true);

    // Hop 4, learner API: each learner sees exactly their own report, with provenance and without the product observation.
    for (const n of LEARNERS) {
      const res = await sessionRoute(reportsRoute, ctxOf(n), '/api/v1/insights/reports');
      expect(res.status).toBe(200);
      const body = await res.json() as { reports: Array<Record<string, unknown>>; queue: { pending: number } };
      expect(body.reports).toHaveLength(1);
      expect(body.reports[0]).toMatchObject({
        missionId: 'plan-weekend', intent: { text: 'Bạn nhờ AI giải thích gợi ý bước 2 của mission cuối tuần.' },
        provenance: { sourceRuntime: 'claude-code', eventCount: 1, promptVersion: 1 },
      });
      expect(body.queue.pending).toBe(0);
      expectClean(`reports API of ${n}`, body, ['product_observation', 'Gợi ý bước 2 của mission cuối tuần khó hiểu']);
    }

    // Tick 3: the settled reports are linked. charlie has no proposals consent, so three count; every category needs 3.
    advance(15 * 60_000);
    result = await tick(stages(model.fetchImpl, gh, draft));
    expect(result).toMatchObject({
      proposal: { status: 'ok', result: { linked: 3, ignored: 1, proposalsCreated: 1, filed: 0, githubMode: 'off' } },
    });
    const evidence = await rows(`SELECT abstract_evidence FROM insight_signal_evidence`);
    expect(evidence.map((e) => e.abstract_evidence).sort()).toEqual([
      'Gợi ý bước 2 của mission cuối tuần khó hiểu với người mới (alpha).',
      'Gợi ý bước 2 của mission cuối tuần khó hiểu với người mới (bravo).',
      'Gợi ý bước 2 của mission cuối tuần khó hiểu với người mới (delta).',
    ]);
    // Hop 5, issue draft: the draft model saw neither secrets nor charlie's text nor any learner identity.
    expect(draft.prompts).toHaveLength(1);
    expectClean('draft prompt', draft.prompts, ['charlie', 'lrn_', '@example.com', 'Học viên']);

    // Hop 6, admin proposals: one dashboard proposal, gate says GitHub is off, issue markdown privacy-checked.
    const list = await json<{ proposals: Array<{ id: string; status: string }>; settings: Record<string, unknown> }>(
      sessionRoute(proposalsRoute, ADMIN, '/api/v1/admin/insights/proposals'));
    expect(list.proposals).toHaveLength(1);
    expect(list.proposals[0].status).toBe('proposed');
    expect(list.settings).toMatchObject({ githubMode: 'off', tokenConfigured: false });
    const detail = await json<{ issueMarkdown: string | null; privacyHits: string[]; proposal: { gate: { decision: string; reasons: string[] } } }>(
      sessionRoute(proposalDetailRoute, ADMIN, `/api/v1/admin/insights/proposals/${list.proposals[0].id}`, { params: { id: list.proposals[0].id } }));
    expect(detail.proposal.gate).toMatchObject({ decision: 'proposal', reasons: expect.arrayContaining(['github_off']) });
    expect(detail.privacyHits).toEqual([]);
    expect(detail.issueMarkdown).toContain('ai-unlocked-fp:');
    expectClean('issue markdown', detail.issueMarkdown, ['charlie', 'lrn_', '@example.com', 'Học viên']);
    expect(await json(sessionRoute(automationRoute, ADMIN, '/api/v1/admin/insights/settings'))).toMatchObject({ githubMode: 'off', tokenConfigured: false });

    // Hop 7, operator summary: counts over all four analysis-consented learners (k ≥ 3); nobody shares detail.
    const summary = await json<{ health: Record<string, unknown>; patterns: { skills: unknown[] }; signals: unknown[]; sharingLearners: unknown[] }>(
      sessionRoute(summaryRoute, ADMIN, '/api/v1/admin/insights/summary'));
    expect(summary.patterns.skills).toEqual([{ key: 'describe', reports: 4, learners: 4 }]);
    expect(summary.signals).toHaveLength(1); // three proposals-consenting learners reach k ≥ 3
    expect(summary.sharingLearners).toEqual([]);
    expectClean('operator summary', summary, ['charlie', 'alpha', 'bravo', 'delta', '@example.com']);

    // Nothing anywhere in the database holds a secret, and nothing ever went to GitHub or the real network.
    expectClean('database', await dumpTables());
    expect(gh.calls).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('opt-out mid-chain: a revoke before the tick or during the model call leaves no report, and later turns are refused', async () => {
    for (const n of ['alpha', 'bravo'] as const) expect((await postTurn(n, devicePayload(n))).status).toBe(202);

    // alpha turns analysis off in Settings before the cron runs: the pending turn is purged at once.
    await setConsent('alpha', { analysis: false });
    expect(await rows(`SELECT id FROM insight_events WHERE learner_id = 'lrn_alpha'`)).toEqual([]);

    // bravo turns it off while ai-tutor is waiting for the model.
    const inner = openRouterFetch(modelReport);
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      await setConsent('bravo', { analysis: false });
      return inner.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    advance(6 * 60_000);
    const result = await tick(stages(fetchImpl, fakeGithub(), stubModel()));
    // The revoke purges the leased events itself, so the stage sees a lost lease rather than counting a revoke;
    // what matters is that the guarded write produced nothing.
    expect(result).toMatchObject({ analyzer: { status: 'ok', result: { analysed: 0, aiCalls: 1, failed: 0, dead: 0 } } });
    expect(inner.calls).toHaveLength(1); // only bravo's window reached the model
    expect(await rows(`SELECT id FROM insight_reports`)).toEqual([]);
    expect(await rows(`SELECT id FROM insight_events`)).toEqual([]);

    // The hook is still installed and keeps sending: the server refuses and stores nothing.
    for (const n of ['alpha', 'bravo'] as const) {
      const res = await postTurn(n, devicePayload(n, 2));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { reason: 'consent_required' } });
    }
    expect(await rows(`SELECT id FROM insight_events`)).toEqual([]);
    for (const n of ['alpha', 'bravo'] as const) {
      expect((await json<{ reports: unknown[] }>(sessionRoute(reportsRoute, ctxOf(n), '/api/v1/insights/reports'))).reports).toEqual([]);
    }
  });

  it('duplicate Stop: the same turn posted twice (and re-fired with stop_hook_active) is one event and one report', async () => {
    const first = devicePayload('alpha');
    const refire = buildTurnPayload({
      input: { session_id: 'session-alpha', prompt_id: 'prompt-1', last_assistant_message: 'Bản cuối sau khi một hook khác yêu cầu tiếp tục.', stop_hook_active: true },
      window: {
        userPrompt: 'Mình là alpha, gợi ý ở bước 2 của mission cuối tuần khó hiểu quá, giải thích giúp mình.',
        tools: [], platform: { mcpTools: ['start_mission'], missionId: 'plan-weekend' }, parsed: true,
      },
      installSalt: 'salt-alpha',
      now: new Date(),
    });
    expect(refire.idempotencyKey).toBe(first.idempotencyKey);
    expect(await json(postTurn('alpha', first))).toEqual({ accepted: true, duplicate: false });
    expect(await json(postTurn('alpha', first))).toEqual({ accepted: true, duplicate: true });
    expect(await json(postTurn('alpha', refire))).toEqual({ accepted: true, duplicate: true });
    const events = await rows(`SELECT idempotency_key, payload_json FROM insight_events`);
    expect(events).toHaveLength(1);
    expect(events[0].idempotency_key).toBe(first.idempotencyKey);
    expect(events[0].idempotency_key).toBe(sha(`session-alpha:prompt-1`));
    expect(JSON.parse(String(events[0].payload_json)).turn.assistantFinal).toBe('Bản cuối sau khi một hook khác yêu cầu tiếp tục.');

    const model = openRouterFetch(modelReport);
    advance(6 * 60_000);
    await tick(stages(model.fetchImpl, fakeGithub(), stubModel()));
    expect(model.calls).toHaveLength(1);
    expect(await rows(`SELECT event_count FROM insight_reports`)).toEqual([{ event_count: 1 }]);
    // A late duplicate after processing changes nothing.
    expect(await json(postTurn('alpha', first))).toEqual({ accepted: true, duplicate: true });
    expect(await rows(`SELECT status FROM insight_events`)).toEqual([{ status: 'done' }]);
  });
});
