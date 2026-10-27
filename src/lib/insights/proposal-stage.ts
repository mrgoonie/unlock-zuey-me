/**
 * Insights cron stage: turns product observations into de-identified signals, proposals and (only when the
 * policy gate and the GitHub mode allow it) GitHub issues. Bounded per tick and charged to the shared cron
 * budget; every step resumes from durable state (cursors, statuses, leases) on the next tick.
 *
 *   1. link    ≤ 50 new reports with a product observation from learners who had `proposals` consent when the
 *              report was written → signal (fingerprint) + evidence
 *   2. eval    ≤ 10 signals with new evidence → cohort stats → draft → privacy check → risk → gate → proposal
 *   3. refresh ≤ 10 proposals whose draft lost its evidence (consent revoked, reports or account deleted)
 *              → evidence-free template, or withdrawn (draft erased, back to a non-fileable `proposed`)
 *   4. recover ≤ 3 filings whose lease expired: link the issue an earlier attempt made, or release the row;
 *              with GitHub off, every expired filing is released without any network call
 *   5. watch   ≤ 5 filed issues → shipped / rejected; shipped + 14 days → monitored
 *
 * The cron never creates a GitHub issue: that takes an operator's explicit "Tạo issue GitHub" click
 * (`fileProposal` with `operator: true`), in every INSIGHTS_GITHUB_ISSUES mode.
 *
 * Learning feedback never reaches this stage (it stays in learner reports) and `personal_preference`
 * observations never become signals. A signal whose proposal is past triage (filed, shipped, rejected…)
 * only accumulates evidence, so a filed issue can never feed a second one.
 */
import { redactText } from '../../../skills/ai-unlocked/scripts/lib/redact.mjs';
import type { CronBudget, CronCost } from '../jobs/cron-budget';
import { newId, parseJson } from '../db/ids';
import { CONSENT_SQL } from './consent-store';
import { DAILY_ISSUE_CAP, githubIssuesMode } from './feature-flags';
import { createGithubIssuePublisher, githubTokenConfigured, LIST_MAX_PAGES, type GithubFetch, type GithubIssuePublisher } from './github-issue-publisher';
import type { GateDecision, GithubIssuesMode, ProposalStatus, SignalCategory, StoredAiTutorReport } from './insight-types';
import {
  buildDraft, defaultDraftModel, DRAFT_EVIDENCE_MAX, parseStoredDraft, templateDraft, type DraftModel, type IssueDraft,
} from './issue-draft';
import { getSafeAutoImplement, SYSTEM_ACTOR } from './operator-settings';
import { assessSignal, currentDraft, persistAssessment, readGateEnv, syncProposalDraft } from './proposal-assessment';
import { fileProposal } from './proposal-filing';
import { PROPOSAL_MIN_COHORT, PROPOSAL_MIN_CONFIDENCE } from './proposal-policy-gate';
import {
  applyIssueState, cohortStats, consentedEvidence, createProposal, daysBefore, filedProposalsToCheck, getProposalWithSignal, getSignal,
  issuesFiledToday, linkEvidenceStatements, MONITOR_WINDOW_DAYS, promoteMonitored, proposalsWithStaleDrafts, pruneIssueCounters, readCursor,
  releaseExpiredFilings,
  REPORT_CURSOR_KEY, SIGNAL_CURSOR_KEY, SIGNAL_WINDOW_DAYS, toProposalSummary, writeCursorStatement,
  type CohortStats, type ProposalRow, type ProposalSummary, type SignalRow,
} from './proposal-store';

export { assessSignal, type Assessment } from './proposal-assessment';
export { fileProposal, ISSUE_COOLDOWN_DAYS, type FileOptions, type FilingOutcome } from './proposal-filing';
import { fingerprint, normalizeArea, signalTitle } from './signal-fingerprint';

export const STAGE_LIMITS = { reports: 50, signals: 10, draftRefreshes: 10, filings: 3, issueChecks: 5 } as const;
/** Reports younger than this are left for the next tick, so a report committed late never slips behind the cursor. */
const REPORT_SETTLE_MS = 60_000;
const ABSTRACT_EVIDENCE_MAX = 240;
const SIGNAL_CATEGORIES = new Set<SignalCategory>(['bug', 'content', 'ux', 'feature']);
const DAY_MS = 86_400_000;

/** Conservative cost estimates of the composite steps. */
const COST = {
  query: { d1: 1 } satisfies CronCost,
  draft: { d1: 6, net: 1 } satisfies CronCost, // runAi: reservation, settle and events rows + one model call
  evaluate: { d1: 16, net: 1 } satisfies CronCost,
  refresh: { d1: 12 } satisfies CronCost,
  // Recovery: a ledger issue read or up to LIST_MAX_PAGES list pages, plus one marker search.
  filing: { d1: 14, net: LIST_MAX_PAGES + 1 } satisfies CronCost,
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
  /** Drafts replaced by the template or withdrawn because their evidence was withdrawn. */
  draftsRefreshed: number;
  /** Issues created (always 0 since the cron stopped creating issues; kept for the result shape). */
  filed: number;
  linkedIssues: number;
  duplicates: number;
  /** Expired filings returned to their resting status (issue not found on GitHub, or GitHub filing off). */
  filingsReleased: number;
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
      CASE WHEN ${CONSENT_SQL.proposalsConsented('r')} AND ic.proposals_at IS NOT NULL AND r.created_at >= ic.proposals_at AND l.deleted_at IS NULL
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
      if (stats.learners >= PROPOSAL_MIN_COHORT && stats.avgConfidence >= PROPOSAL_MIN_CONFIDENCE) {
        const items = await q(COST.query, () => consentedEvidence(db, s.id, since));
        budget.charge(COST.draft);
        const draft = await buildDraft(model, s, stats, items.slice(0, DRAFT_EVIDENCE_MAX));
        const a = await q({ d1: 1 }, () => assessSignal(db, s, draft, gateEnv, now, { stats, evidence: items.map((e) => e.text) }));
        if (a.draft && (a.gate.decision !== 'none' || blockedOnlyByPrivacy(a.gate))) {
          const created = await q(COST.query, () => createProposal(db, {
            id: newId('prp'), signalId: s.id, gate: a.gate, draftJson: JSON.stringify(a.draft), aiHandle: false,
          }, now));
          if (created) result.proposalsCreated++;
        }
      }
      result.evaluated++;
    } else if (open) {
      const stats = await q(COST.query, () => cohortStats(db, s.id, since));
      const state = await q({ d1: 3 }, () => currentDraft(db, s, s.draft_json, stats));
      const a = await q({ d1: 3 }, () => assessSignal(db, s, state.draft, gateEnv, now, { stats }));
      await q({ d1: 2 }, () => persistAssessment(db, s.proposal_id as string, state, a, now));
      if (state.action !== 'keep') result.draftsRefreshed++;
      result.evaluated++;
    }
    await q(COST.query, () => writeCursorStatement(db, SIGNAL_CURSOR_KEY, { at: s.last_seen_at, id: s.id }, now).run());
  }
}

/**
 * Replaces or withdraws drafts whose evidence was withdrawn after they were written (consent revoked,
 * reports or account deleted, retention), so operators never see text built from it. Self-draining: a
 * refreshed draft no longer matches the stale query.
 */
async function refreshStaleDrafts(env: Env, budget: CronBudget, now: Date, result: ProposalStageResult): Promise<void> {
  const db = env.DB;
  const q = charged(budget);
  if (!budget.canAfford({ d1: 4 })) {
    result.deferred = true;
    return;
  }
  const ids = await q(COST.query, () => proposalsWithStaleDrafts(db, PROPOSAL_MIN_COHORT, STAGE_LIMITS.draftRefreshes));
  if (!ids.length) return;
  const gateEnv = await q({ d1: 2 }, () => readGateEnv(env, now));
  for (const id of ids) {
    if (!budget.canAfford(COST.refresh)) {
      result.deferred = true;
      return;
    }
    if (await q(COST.refresh, () => syncProposalDraft(env, id, now, gateEnv))) result.draftsRefreshed++;
  }
}

/**
 * Filings whose lease expired. With GitHub on, each is resolved through `fileProposal` (link the issue an
 * earlier attempt made, else release); nothing is created here. With GitHub off nothing can be looked up, so
 * the rows are released in one statement and their fingerprint claims wait for the next operator filing.
 */
async function recoverExpiredFilings(env: Env, budget: CronBudget, now: Date, publisher: GithubIssuePublisher | null, result: ProposalStageResult): Promise<void> {
  const db = env.DB;
  const q = charged(budget);
  if (!budget.canAfford({ d1: 2 })) {
    result.deferred = true;
    return;
  }
  if (!publisher) {
    result.filingsReleased += await q(COST.query, () => releaseExpiredFilings(db, now));
    return;
  }
  await q(COST.query, () => pruneIssueCounters(db, now));
  const rows = await q(COST.query, () => db.prepare(`SELECT id FROM insight_proposals
    WHERE github_issue_number IS NULL AND status = 'filing' AND (filing_lease_until IS NULL OR filing_lease_until < ?)
    ORDER BY updated_at, id LIMIT ?`).bind(now.toISOString(), STAGE_LIMITS.filings).all<Pick<ProposalRow, 'id'>>());
  for (const { id } of rows.results) {
    if (!budget.canAfford(COST.filing)) {
      result.deferred = true;
      return;
    }
    const outcome = await q(COST.filing, () => fileProposal(env, id, now, { operator: false, actor: SYSTEM_ACTOR, publisher }));
    if (outcome.kind === 'linked') result.linkedIssues++;
    else if (outcome.kind === 'released') result.filingsReleased++;
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
  /** Null when the draft was withdrawn because its consented evidence fell below the minimum. */
  draft: IssueDraft | null;
  /** Null while the privacy check blocks the body or the draft is withdrawn ("copy issue markdown" is then unavailable). */
  issueMarkdown: string | null;
  issueTitle: string;
  privacyHits: string[];
  /** Occurrences in the 14 days before and after shipping (only once shipped). */
  monitoring: { before: CohortStats; after: CohortStats } | null;
}

/** Null for an unknown proposal and for one hidden from operators (see `VISIBLE_PROPOSAL_SQL` in proposal-store.ts). */
export async function proposalDetail(env: Env, id: string, now: Date): Promise<ProposalDetail | null> {
  const db = env.DB;
  const row = await getProposalWithSignal(db, id, { visibleOnly: true });
  if (!row) return null;
  const signal = await getSignal(db, row.signal_id);
  if (!signal) return null;
  const gateEnv = await readGateEnv(env, now);
  const stats = await cohortStats(db, signal.id, daysBefore(now, SIGNAL_WINDOW_DAYS));
  // A filed issue keeps the text it was filed with; any other proposal shows only what its CURRENT
  // consented evidence still supports (read-only here: the cron stage and the filing path persist it).
  const draft = row.github_issue_number === null
    ? (await currentDraft(db, signal, row.draft_json, stats)).draft
    : parseStoredDraft(row.draft_json) ?? templateDraft(signal, stats);
  const a = await assessSignal(db, signal, draft, gateEnv, now, { stats });
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
  const live = row.status === 'proposed' || row.status === 'accepted' || row.status === 'filing';
  const summary = toProposalSummary(row, a.stats);
  return {
    proposal: live ? { ...summary, gate: a.gate, risk: a.gate.risk } : summary,
    fingerprint: row.fingerprint,
    draft: a.draft,
    issueMarkdown: a.markdown,
    issueTitle: a.draft?.title ?? signal.title,
    privacyHits: a.privacyHits,
    monitoring,
  };
}

/** The `proposal` stage of the insights pipeline (signature `InsightsStage`). */
export async function runProposalStage(env: Env, budget: CronBudget, now: Date, deps: ProposalStageDeps = {}): Promise<ProposalStageResult> {
  const githubMode = githubIssuesMode(env);
  const result: ProposalStageResult = {
    linked: 0, ignored: 0, evaluated: 0, proposalsCreated: 0, draftsRefreshed: 0, filed: 0, linkedIssues: 0, duplicates: 0, filingsReleased: 0,
    shipped: 0, monitored: 0, githubMode, deferred: false,
  };
  const model = deps.draftModel ?? defaultDraftModel({ env, now: () => now });
  await linkReports(env, budget, now, result);
  await evaluateSignals(env, budget, now, model, result);
  // Zero GitHub traffic unless the effective mode is on (which already requires the token).
  const publisher = githubMode === 'off' ? null : createGithubIssuePublisher(env, deps.fetchImpl);
  // Released filings rest in a status the draft refresh covers, so recover first.
  await recoverExpiredFilings(env, budget, now, publisher, result);
  await refreshStaleDrafts(env, budget, now, result);
  await watchIssues(env, budget, now, publisher, result);
  return result;
}
