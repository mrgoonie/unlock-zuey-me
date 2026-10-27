/**
 * Shared seeds and fakes for the proposal pipeline tests (not a test file itself). Reports are written
 * straight into insight_reports with the fixed StoredAiTutorReport shape, the GitHub API is a recording
 * fetch mock (no real network), and the draft model is a stub.
 */
import type { DraftModel, DraftSections } from '../../src/lib/insights/issue-draft';
import type { ProductObservation } from '../../src/lib/insights/insight-types';
import { createTestD1 } from '../helpers/d1-sqlite';

export const NOW = new Date('2026-10-26T09:00:00.000Z');
export const minutesAgo = (m: number, from = NOW) => new Date(from.getTime() - m * 60_000).toISOString();
export const daysAgo = (d: number, from = NOW) => new Date(from.getTime() - d * 86_400_000).toISOString();
export const FAKE_TOKEN = 'github_pat_TESTONLY_0123456789abcdefghijklmnopqrstuvwxyz';

export async function freshDb(learners: string[] = ['lrn_a', 'lrn_b', 'lrn_c', 'lrn_d']): Promise<D1Database> {
  const db = createTestD1();
  for (const id of learners) await addLearner(db, id);
  return db;
}

/** A completed mission run (the "established learner" signal of the proposal cohort). */
export async function completeMission(db: D1Database, learnerId: string, completedAt: string) {
  await db.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, started_at, updated_at, completed_at)
    VALUES (?, ?, 'plan-weekend', 1, 'completed', ?, ?, ?)`).bind(`run_${learnerId}_${completedAt}`, learnerId, completedAt, completedAt, completedAt).run();
}

/**
 * A member with proposals consent. By default ESTABLISHED (account 60 days old, one mission completed 30
 * days ago); `createdAt` and `missionCompletedAt` (null: none) override that.
 */
export async function addLearner(
  db: D1Database, id: string,
  opts: { proposals?: boolean; proposalsAt?: string; name?: string; createdAt?: string; missionCompletedAt?: string | null } = {},
) {
  const at = opts.createdAt ?? daysAgo(60);
  await db.prepare(`INSERT INTO learners (id, kind, display_name, email, profile_json, created_at, updated_at) VALUES (?, 'member', ?, ?, '{}', ?, ?)`)
    .bind(id, opts.name ?? `Học viên ${id.slice(4)}`, `${id}@example.com`, at, at).run();
  const missionAt = opts.missionCompletedAt === undefined ? daysAgo(30) : opts.missionCompletedAt;
  if (missionAt) await completeMission(db, id, missionAt);
  const proposals = opts.proposals ?? true;
  await db.prepare(`INSERT INTO insight_consents (learner_id, analysis, share_operator, proposals, analysis_at, proposals_at, updated_at)
    VALUES (?, 1, 0, ?, ?, ?, ?)`).bind(id, proposals ? 1 : 0, at, proposals ? (opts.proposalsAt ?? at) : null, at).run();
}

export const observation = (over: Partial<ProductObservation> = {}): ProductObservation => ({
  category: 'content', area: 'mission:plan-weekend', topic_key: 'hint unclear step', summary: 'Gợi ý bước 2 khó hiểu với người mới.',
  evidence_ref: 'e1', confidence: 0.8, ...over,
});

let seq = 0;
export async function addReport(
  db: D1Database, learnerId: string, obs: ProductObservation | null, opts: { createdAt?: string; id?: string } = {},
): Promise<string> {
  const id = opts.id ?? `irp_t${(++seq).toString().padStart(6, '0')}`;
  const createdAt = opts.createdAt ?? minutesAgo(30);
  const report = {
    relevant: true, intent_summary: { text: 'Lên kế hoạch cuối tuần', confidence: 0.8 }, workflow_observed: [], learning_insights: [],
    verification_gaps: [], risk_signals: [], next_best_action: null, product_observation: obs, confidence: 0.8,
    source_runtime: 'claude-code', created_at: createdAt, model: 'test-model', prompt_version: 1, evidence_refs: ['e1'],
  };
  await db.prepare(`INSERT INTO insight_reports (id, learner_id, session_ref, report_json, intent_summary, confidence, has_product_observation,
      source_runtime, model, prompt_version, event_count, window_started_at, window_ended_at, created_at, expires_at)
    VALUES (?, ?, 'sref', ?, 'Lên kế hoạch', 0.8, ?, 'claude-code', 'test-model', 1, 1, ?, ?, ?, ?)`)
    .bind(id, learnerId, JSON.stringify(report), obs ? 1 : 0, createdAt, createdAt, createdAt, daysAgo(-90)).run();
  return id;
}

export const goodSections = (over: Partial<DraftSections> = {}): DraftSections => ({
  title: 'Clarify the step 2 hint of the weekend planning mission',
  problem: 'Learners new to the mission find the step 2 hint hard to follow.',
  affectedContext: 'Mission plan-weekend, step 2 hint.',
  evidence: 'Several learners asked what the step 2 hint means.',
  proposedChange: 'Rewrite the step 2 hint in plainer words with one example.',
  existingSolutionCheck: 'The concept page does not cover this step.',
  alternatives: 'Add a worked example instead.',
  tradeoffs: 'A longer hint takes more time to read.',
  acceptanceCriteria: '- The hint uses plain words.\n- Fewer learners ask about step 2.',
  blastRadius: 'One hint of one mission.',
  riskHint: 'low',
  ...over,
});

/** Draft model stub recording every prompt it received. */
export function stubModel(sections: DraftSections | Error = goodSections()) {
  const prompts: string[] = [];
  const model: DraftModel = async (messages) => {
    prompts.push(messages.map((m) => m.content).join('\n'));
    if (sections instanceof Error) throw sections;
    return { value: sections, model: 'stub-model' };
  };
  return { model, prompts };
}

export interface FakeIssue {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  closed_at: string | null;
  state_reason: string | null;
  body: string;
  labels: string[];
}

/**
 * Recording GitHub API mock. `issues` doubles as the search index (matched by body substring) and as the
 * repository issue list (`GET /repos/:repo/issues`, filtered by label). `searchLag: true` hides every issue
 * from search, like GitHub's index right after a create; the issue list always sees them.
 */
export function fakeGithub(opts: { createStatus?: number; createStatusAfterCreate?: number; searchStatus?: number; delayMs?: number; searchLag?: boolean } = {}) {
  const issues: FakeIssue[] = [];
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: input, headers, body });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (method === 'GET' && url.pathname === '/search/issues') {
      if (opts.searchStatus) return new Response('{"message":"boom"}', { status: opts.searchStatus });
      const marker = /"(ai-unlocked-fp:[0-9a-f]{64})"/.exec(url.searchParams.get('q') ?? '')?.[1] ?? '';
      return Response.json({ items: opts.searchLag ? [] : issues.filter((i) => i.body.includes(marker)) });
    }
    const list = /^\/repos\/[^/]+\/[^/]+\/issues$/.exec(url.pathname);
    if (method === 'GET' && list) {
      const label = url.searchParams.get('labels');
      const page = Number(url.searchParams.get('page') ?? '1');
      const matching = issues.filter((i) => !label || i.labels.includes(label)).reverse();
      return Response.json(matching.slice((page - 1) * 100, page * 100));
    }
    const create = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname);
    if (method === 'POST' && create) {
      if (opts.createStatus) return new Response('{"message":"Validation Failed"}', { status: opts.createStatus });
      const b = body as { title: string; body: string; labels: string[] };
      const issue: FakeIssue = {
        number: 100 + issues.length, html_url: `https://github.com/${create[1]}/issues/${100 + issues.length}`, state: 'open',
        closed_at: null, state_reason: null, body: b.body, labels: b.labels,
      };
      issues.push(issue);
      // The issue exists on GitHub, but the client sees a failure (timeout or 5xx after the POST).
      if (opts.createStatusAfterCreate) return new Response('{"message":"boom"}', { status: opts.createStatusAfterCreate });
      return Response.json(issue, { status: 201 });
    }
    const labels = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/.exec(url.pathname);
    if (method === 'POST' && labels) {
      const issue = issues.find((i) => i.number === Number(labels[1]));
      issue?.labels.push(...(body as { labels: string[] }).labels);
      return Response.json([]);
    }
    const get = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && get) {
      const issue = issues.find((i) => i.number === Number(get[1]));
      return issue ? Response.json(issue) : new Response('{}', { status: 404 });
    }
    return new Response('{}', { status: 404 });
  };
  const posts = () => calls.filter((c) => c.method === 'POST' && /\/issues$/.test(new URL(c.url).pathname));
  return { issues, calls, fetchImpl, posts };
}

export const baseEnv = (db: D1Database, over: Partial<Env> = {}): Env => ({ DB: db, INSIGHTS_MODE: 'internal', ...over }) as Env;
export const githubEnv = (db: D1Database, mode: 'issues' | 'issues_ai_handle' = 'issues', over: Partial<Env> = {}): Env =>
  baseEnv(db, { INSIGHTS_GITHUB_ISSUES: mode, GITHUB_ISSUES_TOKEN: FAKE_TOKEN, ...over });

/** Three learners report the same low-risk content problem with paraphrased topic keys. */
export async function seedCohort(db: D1Database, learners = ['lrn_a', 'lrn_b', 'lrn_c'], obs: Partial<ProductObservation> = {}) {
  const topics = ['hint unclear step', 'Step hint unclear', 'unclear the hint of step'];
  for (const [i, l] of learners.entries()) await addReport(db, l, observation({ topic_key: topics[i % topics.length], ...obs }));
}
