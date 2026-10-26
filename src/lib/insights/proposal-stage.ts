/**
 * Insights cron stage: turns product observations into de-identified signals, proposals and (only when the
 * policy gate and the GitHub mode allow it) GitHub issues. Bounded per tick and charged to the shared cron
 * budget; every step resumes from durable state (cursors, statuses, leases) on the next tick.
 *
 *   1. link   ≤ 50 new reports with a product observation from learners who had `proposals` consent when the
 *             report was written → signal (fingerprint) + evidence
 *   2. eval   ≤ 10 signals with new evidence → cohort stats → draft → privacy check → risk → gate → proposal
 *   3. file   ≤ 3 proposals (auto-approved by the gate or accepted by an operator), only with GitHub on
 *   4. watch  ≤ 5 filed issues → shipped / rejected; shipped + 14 days → monitored
 *
 * Learning feedback never reaches this stage (it stays in learner reports) and `personal_preference`
 * observations never become signals. A signal whose proposal is past triage (filed, shipped, rejected…)
 * only accumulates evidence, so a filed issue can never feed a second one.
 */
import { redactText } from '../../../skills/ai-unlocked/scripts/lib/redact.mjs';
import type { CronBudget, CronCost } from '../jobs/cron-budget';
import { newId, parseJson } from '../db/ids';
import { DAILY_ISSUE_CAP, githubIssuesMode } from './feature-flags';
import { createGithubIssuePublisher, githubTokenConfigured, GithubIssueError, type GithubFetch, type GithubIssuePublisher } from './github-issue-publisher';
import type { GateDecision, GithubIssuesMode, ProposalStatus, SignalCategory, StoredAiTutorReport } from './insight-types';
import {
  buildDraft, defaultDraftModel, draftRiskHint, draftRiskText, prepareIssue, templateDraft, type DraftModel, type IssueDraft,
} from './issue-draft';
import { getSafeAutoImplement, SYSTEM_ACTOR } from './operator-settings';
import { classifyRisk, evaluateGate, PROPOSAL_MIN_COHORT, PROPOSAL_MIN_CONFIDENCE } from './proposal-policy-gate';
import {
  applyIssueState, cohortStats, consentedEvidence, contributorNames, createProposal, daysBefore, filedProposalsToCheck, getProposal,
  getSignal, issuesFiledToday, leaseForFiling, linkEvidenceStatements, promoteMonitored, pruneIssueCounters, readCursor, recordDuplicateOfIssue,
  recordFiled, releaseFiling, releaseIssueSlot, REPORT_CURSOR_KEY, reserveIssueSlot, SIGNAL_CURSOR_KEY, SIGNAL_WINDOW_DAYS,
  updateProposalDraft, updateProposalGate, writeCursorStatement, getProposalWithSignal, toProposalSummary, MONITOR_WINDOW_DAYS,
  type CohortStats, type ProposalRow, type ProposalSummary, type SignalRow,
} from './proposal-store';
import { fingerprint, normalizeArea, signalTitle } from './signal-fingerprint';

export const STAGE_LIMITS = { reports: 50, signals: 10, filings: 3, issueChecks: 5 } as const;
/** A closed issue with the same fingerprint blocks a new one for this many days. */
export const ISSUE_COOLDOWN_DAYS = 30;
/** Reports younger than this are left for the next tick, so a report committed late never slips behind the cursor. */
const REPORT_SETTLE_MS = 60_000;
const ABSTRACT_EVIDENCE_MAX = 240;
const SIGNAL_CATEGORIES = new Set<SignalCategory>(['bug', 'content', 'ux', 'feature']);

/** Conservative cost estimates of the composite steps. */
const COST = {
  query: { d1: 1 } satisfies CronCost,
  draft: { d1: 6, net: 1 } satisfies CronCost, // runAi: reservation, settle and events rows + one model call
  evaluate: { d1: 12, net: 1 } satisfies CronCost,
  filing: { d1: 14, net: 2 } satisfies CronCost,
  issueCheck: { d1: 2, net: 1 } satisfies CronCost,
};

export interface ProposalStageDeps {
  /** GitHub transport (tests inject a mock). */
  fetchImpl?: GithubFetch;
  draftModel?: DraftModel;
}

export interface ProposalStageResult {
  linked: number;
  ignored: number;
  evaluated: number;
  proposalsCreated: number;
  filed: number;
  linkedIssues: number;
  duplicates: number;
  shipped: number;
  monitored: number;
  githubMode: GithubIssuesMode;
  deferred: boolean;
}

/** One budget-charging D1 helper per stage run. */
function charged(budget: CronBudget) {
  return async <T>(cost: CronCost, work: () => Promise<T>): Promise<T> => {
    budget.charge(cost);
    return work();
  };
}

interface ParsedObservation {
  category: SignalCategory;
  area: string;
  topicKey: string;
  summary: string;
  confidence: number;
}

/** The report's product observation, or null when absent, malformed or a personal preference. */
export function parseObservation(reportJson: string | null): ParsedObservation | null {
  const po = parseJson<Partial<StoredAiTutorReport>>(reportJson, {}).product_observation;
  if (!po || typeof po !== 'object') return null;
  const { category, area, topic_key: topicKey, summary, confidence } = po as unknown as Record<string, unknown>;
  if (typeof category !== 'string' || !SIGNAL_CATEGORIES.has(category as SignalCategory)) return null;
  if (typeof topicKey !== 'string' || typeof summary !== 'string' || typeof area !== 'string') return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  const clean = redactText(summary.replace(/\s+/g, ' ').trim()).text.slice(0, ABSTRACT_EVIDENCE_MAX);
  if (!clean) return null;
  return { category: category as SignalCategory, area: normalizeArea(area), topicKey, summary: clean, confidence: Math.min(1, Math.max(0, confidence)) };
}

interface ReportCandidate {
  id: string;
  created_at: string;
  /** NULL unless the learner had proposals consent when the report was written (and still has, and exists). */
  report_json: string | null;
}

async function linkReports(env: Env, budget: CronBudget, now: Date, result: ProposalStageResult): Promise<void> {
  const db = env.DB;
  const q = charged(budget);
  if (!budget.canAfford({ d1: 3 })) {
    result.deferred = true;
    return;
  }
  const cursor = await q(COST.query, () => readCursor(db, REPORT_CURSOR_KEY));
  const settled = new Date(now.getTime() - REPORT_SETTLE_MS).toISOString();
  const rows = await q(COST.query, () => db.prepare(`SELECT r.id, r.created_at,
      CASE WHEN ic.proposals = 1 AND ic.proposals_at IS NOT NULL AND r.created_at >= ic.proposals_at AND l.deleted_at IS NULL
        THEN r.report_json END AS report_json
    FROM insight_reports r
    LEFT JOIN insight_consents ic ON ic.learner_id = r.learner_id
    JOIN learners l ON l.id = r.learner_id
    WHERE r.has_product_observation = 1 AND (r.created_at > ? OR (r.created_at = ? AND r.id > ?)) AND r.created_at <= ?
    ORDER BY r.created_at, r.id LIMIT ?`).bind(cursor.at, cursor.at, cursor.id, settled, STAGE_LIMITS.reports).all<ReportCandidate>());
  for (const row of rows.results) {
    if (!budget.canAfford(COST.query)) {
      result.deferred = true;
      return;
    }
    const obs = parseObservation(row.report_json);
    const stmts = [writeCursorStatement(db, REPORT_CURSOR_KEY, { at: row.created_at, id: row.id }, now)];
    if (obs) {
      const fp = await fingerprint(obs.category, obs.area, obs.topicKey);
      stmts.unshift(...linkEvidenceStatements(db, {
        fingerprint: fp, category: obs.category, area: obs.area, title: signalTitle(obs.category, obs.area, obs.topicKey),
        reportId: row.id, abstractEvidence: obs.summary, confidence: obs.confidence, evidenceAt: row.created_at,
      }, newId('sig'), now));
    }
    // The cursor moves in the same atomic batch as the link, so a crash never skips or double-counts a report.
    await q(COST.query, () => db.batch(stmts));
    if (obs) result.linked++;
    else result.ignored++;
  }
}

interface GateEnv {
  githubMode: GithubIssuesMode;
  tokenConfigured: boolean;
  safeAutoImplement: boolean;
  issuesFiledToday: number;
}

/** Mode, token presence, operator toggle and today's issue count (two D1 queries). */
async function readGateEnv(env: Env, now: Date): Promise<GateEnv> {
  return {
    githubMode: githubIssuesMode(env),
    tokenConfigured: githubTokenConfigured(env),
    safeAutoImplement: await getSafeAutoImplement(env.DB),
    issuesFiledToday: await issuesFiledToday(env.DB, now),
  };
}

export interface Assessment {
  draft: IssueDraft;
  /** Rendered, privacy-checked issue body; null when blocked by the privacy check. */
  markdown: string | null;
  privacyHits: string[];
  stats: CohortStats;
  gate: GateDecision;
}

/**
 * Current cohort, privacy check, deterministic risk and gate for a signal and its draft. Risk is computed
 * from controlled fields plus a denylist scan of every draft text; the model's hint and text only raise it.
 */
export async function assessSignal(
  db: D1Database, signal: SignalRow, draft: IssueDraft, gateEnv: GateEnv, now: Date, known?: { stats: CohortStats; evidence: string[] },
): Promise<Assessment> {
  const since = daysBefore(now, SIGNAL_WINDOW_DAYS);
  const stats = known?.stats ?? await cohortStats(db, signal.id, since);
  const evidence = known?.evidence ?? await consentedEvidence(db, signal.id, since);
  const prepared = prepareIssue(draft, signal, stats, evidence, await contributorNames(db, signal.id));
  const { risk, denylistHit } = classifyRisk({
    category: signal.category,
    area: signal.area,
    draftText: [signal.title, draftRiskText(draft), draftRiskText(prepared.draft), ...evidence].join('\n'),
    modelRiskHint: draftRiskHint(draft),
  });
  const gate = evaluateGate(
    { category: signal.category, risk, denylistHit, cohort: stats.learners, confidence: stats.avgConfidence, privacyClean: prepared.privacy.ok },
    { ...gateEnv, dailyCap: DAILY_ISSUE_CAP },
  );
  return { draft: prepared.draft, markdown: prepared.markdown, privacyHits: prepared.privacy.hits, stats, gate };
}

/** Only a privacy failure keeps a `none` signal visible (as blocked); every other `none` waits for evidence. */
const blockedOnlyByPrivacy = (g: GateDecision) => g.decision === 'none' && g.reasons.length > 0 && g.reasons.every((r) => r === 'privacy');

interface SignalCandidate extends SignalRow {
  proposal_id: string | null;
  proposal_status: ProposalStatus | null;
  draft_json: string | null;
}

async function evaluateSignals(env: Env, budget: CronBudget, now: Date, model: DraftModel, result: ProposalStageResult): Promise<void> {
  const db = env.DB;
  const q = charged(budget);
  if (!budget.canAfford({ d1: 4 })) {
    result.deferred = true;
    return;
  }
  const gateEnv = await q({ d1: 2 }, () => readGateEnv(env, now));
  const cursor = await q(COST.query, () => readCursor(db, SIGNAL_CURSOR_KEY));
  const rows = await q(COST.query, () => db.prepare(`SELECT s.id, s.fingerprint, s.category, s.area, s.title, s.first_seen_at, s.last_seen_at,
      p.id AS proposal_id, p.status AS proposal_status, p.draft_json
    FROM insight_signals s LEFT JOIN insight_proposals p ON p.signal_id = s.id
    WHERE s.last_seen_at > ? OR (s.last_seen_at = ? AND s.id > ?) ORDER BY s.last_seen_at, s.id LIMIT ?`)
    .bind(cursor.at, cursor.at, cursor.id, STAGE_LIMITS.signals).all<SignalCandidate>());
  const since = daysBefore(now, SIGNAL_WINDOW_DAYS);
  for (const s of rows.results) {
    if (!budget.canAfford(COST.evaluate)) {
      result.deferred = true;
      return;
    }
    const open = s.proposal_status === 'proposed' || s.proposal_status === 'accepted';
    if (!s.proposal_id) {
      const stats = await q(COST.query, () => cohortStats(db, s.id, since));
      // Cheap pre-gate: no model call for a signal that cannot become a proposal yet.
      if (stats.learners >= PROPOSAL_MIN_COHORT[s.category] && stats.avgConfidence >= PROPOSAL_MIN_CONFIDENCE) {
        const evidence = await q(COST.query, () => consentedEvidence(db, s.id, since));
        budget.charge(COST.draft);
        const draft = await buildDraft(model, s, stats, evidence);
        const a = await q({ d1: 1 }, () => assessSignal(db, s, draft, gateEnv, now, { stats, evidence }));
        if (a.gate.decision !== 'none' || blockedOnlyByPrivacy(a.gate)) {
          const created = await q(COST.query, () => createProposal(db, {
            id: newId('prp'), signalId: s.id, gate: a.gate, draftJson: JSON.stringify(a.draft), aiHandle: false,
          }, now));
          if (created) result.proposalsCreated++;
        }
      }
      result.evaluated++;
    } else if (open) {
      const stored = parseJson<IssueDraft | null>(s.draft_json, null) ?? templateDraft(s, await cohortStats(db, s.id, since), []);
      const a = await q({ d1: 3 }, () => assessSignal(db, s, stored, gateEnv, now));
      await q(COST.query, () => updateProposalGate(db, s.proposal_id as string, a.gate, now));
      if (a.draft !== stored) await q(COST.query, () => updateProposalDraft(db, s.proposal_id as string, JSON.stringify(a.draft), now));
      result.evaluated++;
    }
    await q(COST.query, () => writeCursorStatement(db, SIGNAL_CURSOR_KEY, { at: s.last_seen_at, id: s.id }, now).run());
  }
}

// ---------------------------------------------------------------------------------------------------------
// Filing (shared by the cron stage and the admin `file_issue` action)

export type FilingOutcome =
  | { kind: 'filed'; number: number; url: string; aiHandle: boolean }
  | { kind: 'linked'; number: number; url: string }
  | { kind: 'duplicate'; url: string }
  | { kind: 'github_off' }
  | { kind: 'not_found' }
  | { kind: 'invalid_status' }
  | { kind: 'busy' }
  | { kind: 'privacy_blocked' }
  | { kind: 'not_allowed'; gate: GateDecision }
  | { kind: 'daily_cap' }
  | { kind: 'github_error'; status: number };

export interface FileOptions {
  /** True for the admin action: the operator's decision replaces the gate's issue tier (never privacy or the cap). */
  operator: boolean;
  actor: string;
  publisher?: GithubIssuePublisher | null;
  fetchImpl?: GithubFetch;
}

const DAY_MS = 86_400_000;

/**
 * Files one proposal: lease → (privacy, gate, cap) → marker search → link, cooldown duplicate, or create.
 * Exactly one concurrent caller holds the lease, so concurrent filings make at most one POST.
 * `ai-handle` is labelled only under mode `issues_ai_handle` and only when the deterministic gate says
 * `issue_ai_handle` or an operator approval is recorded.
 */
export async function fileProposal(env: Env, proposalId: string, now: Date, opts: FileOptions): Promise<FilingOutcome> {
  const db = env.DB;
  const mode = githubIssuesMode(env);
  const publisher = opts.publisher === undefined ? createGithubIssuePublisher(env, opts.fetchImpl) : opts.publisher;
  if (mode === 'off' || !publisher) return { kind: 'github_off' };

  const p = await getProposal(db, proposalId);
  if (!p) return { kind: 'not_found' };
  if (p.github_issue_number !== null || !['proposed', 'accepted', 'filing'].includes(p.status)) return { kind: 'invalid_status' };
  const signal = await getSignal(db, p.signal_id);
  if (!signal) return { kind: 'not_found' };

  const gateEnv = await readGateEnv(env, now);
  const stored = parseJson<IssueDraft | null>(p.draft_json, null) ?? templateDraft(signal, await cohortStats(db, signal.id, daysBefore(now, SIGNAL_WINDOW_DAYS)), []);
  const a = await assessSignal(db, signal, stored, gateEnv, now);
  if (!a.markdown) {
    await updateProposalGate(db, p.id, a.gate, now);
    return { kind: 'privacy_blocked' };
  }
  const operatorApproved = opts.operator || p.status === 'accepted' || (p.status === 'filing' && p.decided_by !== null);
  const autoTier = a.gate.decision === 'issue' || a.gate.decision === 'issue_ai_handle';
  if (a.gate.reasons.includes('daily_cap')) {
    await updateProposalGate(db, p.id, a.gate, now);
    return { kind: 'daily_cap' };
  }
  if (!autoTier && !operatorApproved) {
    await updateProposalGate(db, p.id, a.gate, now);
    return { kind: 'not_allowed', gate: a.gate };
  }
  const aiHandle = mode === 'issues_ai_handle' && (a.gate.decision === 'issue_ai_handle' || p.ai_handle_approved_by !== null);

  if (!(await leaseForFiling(db, p.id, now))) return { kind: 'busy' };
  const prior: ProposalStatus = p.status;
  let slotReserved = false;
  try {
    const existing = await publisher.searchByFingerprint(signal.fingerprint);
    const open = existing.find((i) => i.state === 'open');
    if (open) {
      await recordFiled(db, p.id, { number: open.number, url: open.url, aiHandle: false }, opts.actor, now);
      return { kind: 'linked', number: open.number, url: open.url };
    }
    const recentClosed = existing
      .filter((i) => i.closedAt && now.getTime() - Date.parse(i.closedAt) < ISSUE_COOLDOWN_DAYS * DAY_MS)
      .sort((x, y) => Date.parse(y.closedAt as string) - Date.parse(x.closedAt as string))[0];
    if (recentClosed) {
      await recordDuplicateOfIssue(db, p.id, recentClosed.url, now);
      return { kind: 'duplicate', url: recentClosed.url };
    }
    if (!(await reserveIssueSlot(db, now, DAILY_ISSUE_CAP))) {
      await releaseFiling(db, p.id, prior, now);
      return { kind: 'daily_cap' };
    }
    slotReserved = true;
    const issue = await publisher.createIssue({ title: a.draft.title, body: a.markdown, category: signal.category, aiHandle });
    await recordFiled(db, p.id, { number: issue.number, url: issue.url, aiHandle }, opts.actor, now);
    return { kind: 'filed', number: issue.number, url: issue.url, aiHandle };
  } catch (err) {
    const status = err instanceof GithubIssueError ? err.status : 500;
    const ambiguousCreate = slotReserved && err instanceof GithubIssueError && err.endpoint === 'POST /repos/:repo/issues' && (status === 0 || status >= 500);
    if (ambiguousCreate) {
      // The issue may exist: keep the lease and the slot so the retry (after the lease expires) finds it by marker.
      return { kind: 'github_error', status };
    }
    if (slotReserved) await releaseIssueSlot(db, now).catch(() => undefined);
    await releaseFiling(db, p.id, prior, now);
    if (!(err instanceof GithubIssueError)) console.error('insights filing failed', err instanceof Error ? err.name : 'error');
    return { kind: 'github_error', status };
  }
}

async function fileApproved(env: Env, budget: CronBudget, now: Date, publisher: GithubIssuePublisher, result: ProposalStageResult): Promise<void> {
  const db = env.DB;
  const q = charged(budget);
  if (!budget.canAfford({ d1: 2 })) {
    result.deferred = true;
    return;
  }
  await q(COST.query, () => pruneIssueCounters(db, now));
  const rows = await q(COST.query, () => db.prepare(`SELECT id FROM insight_proposals WHERE github_issue_number IS NULL AND (
      status = 'accepted'
      OR (status = 'proposed' AND (json_extract(gate_json, '$.decision') IN ('issue', 'issue_ai_handle')
        OR EXISTS (SELECT 1 FROM json_each(gate_json, '$.reasons') WHERE value = 'daily_cap')))
      OR (status = 'filing' AND filing_lease_until < ?)
    ) ORDER BY updated_at, id LIMIT ?`).bind(now.toISOString(), STAGE_LIMITS.filings).all<Pick<ProposalRow, 'id'>>());
  for (const { id } of rows.results) {
    if (!budget.canAfford(COST.filing)) {
      result.deferred = true;
      return;
    }
    const outcome = await q(COST.filing, () => fileProposal(env, id, now, { operator: false, actor: SYSTEM_ACTOR, publisher }));
    if (outcome.kind === 'filed') result.filed++;
    else if (outcome.kind === 'linked') result.linkedIssues++;
    else if (outcome.kind === 'duplicate') result.duplicates++;
    else if (outcome.kind === 'daily_cap') return;
  }
}

async function watchIssues(env: Env, budget: CronBudget, now: Date, publisher: GithubIssuePublisher | null, result: ProposalStageResult): Promise<void> {
  const db = env.DB;
  const q = charged(budget);
  if (publisher && budget.canAfford(COST.query)) {
    const rows = await q(COST.query, () => filedProposalsToCheck(db, STAGE_LIMITS.issueChecks));
    for (const row of rows) {
      if (!budget.canAfford(COST.issueCheck)) {
        result.deferred = true;
        break;
      }
      try {
        budget.charge({ net: 1 });
        const issue = await publisher.getIssueState(row.github_issue_number);
        if ((await q(COST.query, () => applyIssueState(db, row.id, issue, now))) === 'shipped') result.shipped++;
      } catch {
        // Logged by the publisher (status + endpoint); retried on a later tick.
      }
    }
  }
  if (budget.canAfford(COST.query)) result.monitored = await q(COST.query, () => promoteMonitored(db, now));
  else result.deferred = true;
}

/** Automation settings as the admin UI sees them. `tokenConfigured` is a boolean; the token never leaves the publisher. */
export interface AutomationSettings {
  githubMode: GithubIssuesMode;
  tokenConfigured: boolean;
  safeAutoImplement: boolean;
  dailyCap: number;
  issuesFiledToday: number;
}

export async function automationSettings(env: Env, now: Date): Promise<AutomationSettings> {
  const [safeAutoImplement, filedToday] = await Promise.all([getSafeAutoImplement(env.DB), issuesFiledToday(env.DB, now)]);
  return {
    githubMode: githubIssuesMode(env), tokenConfigured: githubTokenConfigured(env), safeAutoImplement,
    dailyCap: DAILY_ISSUE_CAP, issuesFiledToday: filedToday,
  };
}

/** Admin detail of one proposal: fresh gate, draft, privacy-checked issue markdown and post-ship monitoring. */
export interface ProposalDetail {
  proposal: ProposalSummary;
  fingerprint: string;
  draft: IssueDraft;
  /** Null while the privacy check blocks the body ("copy issue markdown" is then unavailable). */
  issueMarkdown: string | null;
  issueTitle: string;
  privacyHits: string[];
  /** Occurrences in the 14 days before and after shipping (only once shipped). */
  monitoring: { before: CohortStats; after: CohortStats } | null;
}

export async function proposalDetail(env: Env, id: string, now: Date): Promise<ProposalDetail | null> {
  const db = env.DB;
  const row = await getProposalWithSignal(db, id);
  if (!row) return null;
  const signal = await getSignal(db, row.signal_id);
  if (!signal) return null;
  const stored = parseJson<IssueDraft | null>(row.draft_json, null);
  const gateEnv = await readGateEnv(env, now);
  const a = await assessSignal(db, signal, stored ?? templateDraft(signal, await cohortStats(db, signal.id, daysBefore(now, SIGNAL_WINDOW_DAYS)), []), gateEnv, now);
  let monitoring: ProposalDetail['monitoring'] = null;
  if (row.shipped_at) {
    const shipped = Date.parse(row.shipped_at);
    const iso = (ms: number) => new Date(ms).toISOString();
    const [before, after] = await Promise.all([
      cohortStats(db, signal.id, iso(shipped - MONITOR_WINDOW_DAYS * DAY_MS), row.shipped_at),
      cohortStats(db, signal.id, row.shipped_at, iso(shipped + MONITOR_WINDOW_DAYS * DAY_MS)),
    ]);
    monitoring = { before, after };
  }
  // Statuses past triage keep their recorded gate; open ones show the fresh evaluation.
  const live = row.status === 'proposed' || row.status === 'accepted';
  const summary = toProposalSummary(row, a.stats);
  return {
    proposal: live ? { ...summary, gate: a.gate, risk: a.gate.risk } : summary,
    fingerprint: row.fingerprint,
    draft: a.draft,
    issueMarkdown: a.markdown,
    issueTitle: a.draft.title,
    privacyHits: a.privacyHits,
    monitoring,
  };
}

/** The `proposal` stage of the insights pipeline (signature `InsightsStage`). */
export async function runProposalStage(env: Env, budget: CronBudget, now: Date, deps: ProposalStageDeps = {}): Promise<ProposalStageResult> {
  const githubMode = githubIssuesMode(env);
  const result: ProposalStageResult = {
    linked: 0, ignored: 0, evaluated: 0, proposalsCreated: 0, filed: 0, linkedIssues: 0, duplicates: 0, shipped: 0, monitored: 0,
    githubMode, deferred: false,
  };
  const model = deps.draftModel ?? defaultDraftModel({ env, now: () => now });
  await linkReports(env, budget, now, result);
  await evaluateSignals(env, budget, now, model, result);
  // Zero GitHub traffic unless the effective mode is on (which already requires the token).
  const publisher = githubMode === 'off' ? null : createGithubIssuePublisher(env, deps.fetchImpl);
  if (publisher) await fileApproved(env, budget, now, publisher, result);
  await watchIssues(env, budget, now, publisher, result);
  return result;
}
