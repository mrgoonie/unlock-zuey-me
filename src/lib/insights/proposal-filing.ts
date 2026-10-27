/**
 * Filing one proposal as a GitHub issue. A new issue is only ever created by an operator's explicit
 * `file_issue` click on /admin/insights/proposals, in every INSIGHTS_GITHUB_ISSUES mode; the cron stage
 * only resolves filings whose lease expired (link the issue an earlier attempt made, or release the row).
 *
 *   lease → known issues (D1 ledger, issue list, marker search) → [expired lease: link, else release]
 *   → current draft and gate from the CURRENT consented evidence → privacy, evidence, daily cap
 *   → link an open issue, cooldown duplicate, or claim the fingerprint and create
 *
 * The evidence gate (cohort ≥ 3 established consenting learners, confidence ≥ 0.75, not withdrawn) binds the
 * operator too: an operator decision only replaces the risk tier. The fingerprint claim in D1
 * (proposal-issue-ledger.ts) makes one fingerprint impossible to file twice, whatever GitHub search shows.
 * Every outcome that files nothing releases the lease, so no proposal stays in `filing`; only an ambiguous
 * create (network error or 5xx after the POST) keeps it, together with its claim and its daily slot.
 */
import { createGithubIssuePublisher, GithubIssueError, type GithubFetch, type GithubIssuePublisher, type GithubIssueRef } from './github-issue-publisher';
import { DAILY_ISSUE_CAP, githubIssuesMode } from './feature-flags';
import type { GateDecision, GateReason, ProposalStatus } from './insight-types';
import { assessSignal, currentDraft, persistAssessment, readGateEnv, replacesDraft, type Assessment } from './proposal-assessment';
import { claimIssueFiling, dropIssueClaim, getIssueFiling, knownIssues, recordIssueFilingStatement } from './proposal-issue-ledger';
import {
  cohortStats, daysBefore, FILEABLE_STATUSES, FILING_LEASE_MS, getProposal, getSignal, leaseForFiling, recordDuplicateOfIssue, recordFiledStatement, releaseFiling,
  releaseIssueSlot, reserveIssueSlot, SIGNAL_WINDOW_DAYS,
} from './proposal-store';

/** A closed issue with the same fingerprint blocks a new one for this many days. */
export const ISSUE_COOLDOWN_DAYS = 30;
const DAY_MS = 86_400_000;
const CREATE_ENDPOINT = 'POST /repos/:repo/issues';

export type FilingOutcome =
  | { kind: 'filed'; number: number; url: string; aiHandle: boolean }
  | { kind: 'linked'; number: number; url: string }
  | { kind: 'duplicate'; url: string }
  /** An expired filing lease whose earlier attempt left no issue on GitHub: returned to its resting status. */
  | { kind: 'released' }
  | { kind: 'github_off' }
  | { kind: 'not_found' }
  | { kind: 'invalid_status' }
  | { kind: 'busy' }
  /** Only an operator's explicit file action creates an issue; the cron never does. */
  | { kind: 'operator_required' }
  | { kind: 'privacy_blocked' }
  | { kind: 'not_allowed'; gate: GateDecision }
  | { kind: 'daily_cap' }
  | { kind: 'github_error'; status: number };

export interface FileOptions {
  /** True for the admin `file_issue` action, the only caller allowed to create an issue. */
  operator: boolean;
  actor: string;
  publisher?: GithubIssuePublisher | null;
  fetchImpl?: GithubFetch;
}

/** Gate reasons about the evidence itself, which no operator decision can override. */
const EVIDENCE_REASONS: ReadonlySet<GateReason> = new Set(['personal_preference', 'cohort_too_small', 'low_confidence', 'privacy']);

/** Why this assessment may not be filed now, or null when it may (the operator's click replaces the risk tier). */
function filingRefusal(a: Assessment): FilingOutcome | null {
  if (!a.draft) return { kind: 'not_allowed', gate: a.gate };
  if (!a.markdown) return { kind: 'privacy_blocked' };
  if (a.gate.decision === 'none' || a.gate.reasons.some((r) => EVIDENCE_REASONS.has(r))) return { kind: 'not_allowed', gate: a.gate };
  if (a.gate.reasons.includes('daily_cap')) return { kind: 'daily_cap' };
  return null;
}

/**
 * Time left on the lease below which an attempt does not start a create: a POST that may still be running
 * when the lease expires could be missed by the attempt that takes the row over. Several GitHub timeouts.
 */
const CREATE_LEASE_HEADROOM_MS = 30_000;

/** The lease and the fingerprint claim an attempt holds; its writes apply only while both are still its own. */
interface Hold { lease: string; claimedAt: string | null }

/**
 * Records an issue for the proposal and the fingerprint ledger in one batch, guarded by the attempt's hold.
 * Returns false when the hold was lost (another attempt took the row over): nothing was written.
 */
async function linkIssue(
  db: D1Database, proposalId: string, fingerprint: string, issue: GithubIssueRef, aiHandle: boolean, actor: string, now: Date, hold: Hold,
): Promise<boolean> {
  const [, filed] = await db.batch([
    recordIssueFilingStatement(db, fingerprint, proposalId, issue, now, hold),
    recordFiledStatement(db, proposalId, hold.lease, { number: issue.number, url: issue.url, aiHandle }, actor, now),
  ]);
  return (filed.meta.changes ?? 0) === 1;
}

/**
 * Files one proposal (see file header). Exactly one concurrent caller holds the lease and one holds the
 * fingerprint claim, so concurrent filings make at most one POST. `ai-handle` is labelled only under mode
 * `issues_ai_handle` and only when the deterministic gate says `issue_ai_handle` or an operator approval,
 * given on the text being filed, is recorded.
 */
export async function fileProposal(env: Env, proposalId: string, now: Date, opts: FileOptions): Promise<FilingOutcome> {
  const db = env.DB;
  const mode = githubIssuesMode(env);
  const publisher = opts.publisher === undefined ? createGithubIssuePublisher(env, opts.fetchImpl) : opts.publisher;
  if (mode === 'off' || !publisher) return { kind: 'github_off' };

  const p = await getProposal(db, proposalId);
  if (!p) return { kind: 'not_found' };
  if (p.github_issue_number !== null || !FILEABLE_STATUSES.includes(p.status)) return { kind: 'invalid_status' };
  if (!opts.operator && p.status !== 'filing') return { kind: 'operator_required' };
  const signal = await getSignal(db, p.signal_id);
  if (!signal) return { kind: 'not_found' };
  const fp = signal.fingerprint;

  const started = Date.now(); // elapsed wall time, independent of how `now` was taken
  const lease = await leaseForFiling(db, p.id, now);
  if (!lease) return { kind: 'busy' };
  const prior = p.status;
  /** Where the row returns when this attempt files nothing (an acceptance voided by a draft change → proposed). */
  let resting: ProposalStatus = prior;
  let slotReserved = false;
  let claimedAt: string | null = null;
  let created = false;
  try {
    const ledger = await getIssueFiling(db, fp);
    const lookUp = async () => {
      const known = await knownIssues(publisher, fp, ledger);
      return { known, open: known.all.find((i) => i.state === 'open') };
    };

    if (prior === 'filing') {
      const { known, open } = await lookUp();
      // An earlier attempt crashed or its create was ambiguous. Link the issue it made (or any open one for
      // this fingerprint), whatever the gate says now: it is public either way. Otherwise the listing proved
      // no issue exists, so the claim goes and the row returns to rest; a new create needs an operator.
      const made = open ?? (ledger?.status === 'creating' ? known.ledgerIssue : null);
      if (made) {
        if (!(await linkIssue(db, p.id, fp, made, made.aiHandle ?? false, opts.actor, now, { lease, claimedAt: null }))) return { kind: 'busy' };
        return { kind: 'linked', number: made.number, url: made.url };
      }
      if (ledger?.status === 'creating') await dropIssueClaim(db, fp, ledger.claimed_at);
      await releaseFiling(db, p.id, prior, now);
      return { kind: 'released' };
    }

    // Right before filing: the draft and the gate from the evidence that is consented NOW.
    const gateEnv = await readGateEnv(env, now);
    const stats = await cohortStats(db, signal.id, daysBefore(now, SIGNAL_WINDOW_DAYS));
    const state = await currentDraft(db, signal, p.draft_json, stats);
    const a = await assessSignal(db, signal, state.draft, gateEnv, now, { stats });
    const textChanged = replacesDraft(state, a);
    if (textChanged && prior === 'accepted') resting = 'proposed';
    const refusal = filingRefusal(a);
    if (refusal) {
      if (state.action !== 'withdraw') await releaseFiling(db, p.id, prior, now);
      await persistAssessment(db, p.id, state, a, now); // a withdrawal also drops the lease; a new text voids decisions
      return refusal;
    }
    if (!a.draft || !a.markdown) throw new Error('unreachable: refusal covers a missing draft or body');
    await persistAssessment(db, p.id, state, a, now);
    // An approval recorded for a text this filing just replaced does not carry over.
    const approved = p.ai_handle_approved_by !== null && !textChanged;
    const aiHandle = mode === 'issues_ai_handle' && (a.gate.decision === 'issue_ai_handle' || approved);

    const { known, open } = await lookUp();
    if (open) {
      if (!(await linkIssue(db, p.id, fp, open, open.aiHandle ?? false, opts.actor, now, { lease, claimedAt: null }))) return { kind: 'busy' };
      return { kind: 'linked', number: open.number, url: open.url };
    }
    const recentClosed = known.all
      .filter((i) => i.closedAt && now.getTime() - Date.parse(i.closedAt) < ISSUE_COOLDOWN_DAYS * DAY_MS)
      .sort((x, y) => Date.parse(y.closedAt as string) - Date.parse(x.closedAt as string))[0];
    if (recentClosed) {
      await recordDuplicateOfIssue(db, p.id, recentClosed.url, now);
      return { kind: 'duplicate', url: recentClosed.url };
    }
    if (!(await reserveIssueSlot(db, now, DAILY_ISSUE_CAP))) {
      await releaseFiling(db, p.id, resting, now);
      return { kind: 'daily_cap' };
    }
    slotReserved = true;
    // The ledger row read above is now known to have no live issue (or none at all): take it over atomically.
    claimedAt = await claimIssueFiling(db, fp, p.id, ledger, now);
    if (!claimedAt) {
      await releaseIssueSlot(db, now);
      slotReserved = false;
      await releaseFiling(db, p.id, resting, now);
      return { kind: 'busy' };
    }
    if (Date.now() - started > FILING_LEASE_MS - CREATE_LEASE_HEADROOM_MS) {
      // Too slow so far to be sure the POST ends inside the lease: give everything back, create nothing.
      await dropIssueClaim(db, fp, claimedAt);
      claimedAt = null;
      await releaseIssueSlot(db, now);
      slotReserved = false;
      await releaseFiling(db, p.id, resting, now);
      return { kind: 'busy' };
    }
    const issue = await publisher.createIssue({ title: a.draft.title, body: a.markdown, category: signal.category, aiHandle });
    created = true;
    if (!(await linkIssue(db, p.id, fp, issue, aiHandle, opts.actor, now, { lease, claimedAt }))) {
      console.error('insights filing: issue created after the lease was lost', issue.number);
      return { kind: 'github_error', status: 409 };
    }
    return { kind: 'filed', number: issue.number, url: issue.url, aiHandle };
  } catch (err) {
    const status = err instanceof GithubIssueError ? err.status : 500;
    const ambiguousCreate = claimedAt !== null && err instanceof GithubIssueError && err.endpoint === CREATE_ENDPOINT && (status === 0 || status >= 500);
    if (ambiguousCreate || created) {
      // The issue may exist (or does, but recording it failed): keep the lease, the claim and the slot; the
      // attempt after the lease expires finds it in the issue list before anything else can be created.
      if (created) console.error('insights filing: issue created but not recorded', err instanceof Error ? err.name : 'error');
      return { kind: 'github_error', status };
    }
    // Here GitHub answered the create with a 4xx (nothing created) or it was never reached.
    if (claimedAt) await dropIssueClaim(db, fp, claimedAt).catch(() => undefined);
    if (slotReserved) await releaseIssueSlot(db, now).catch(() => undefined);
    await releaseFiling(db, p.id, resting, now);
    if (!(err instanceof GithubIssueError)) console.error('insights filing failed', err instanceof Error ? err.name : 'error');
    return { kind: 'github_error', status };
  }
}
