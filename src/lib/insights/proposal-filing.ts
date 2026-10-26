/**
 * Filing one proposal as a GitHub issue. Shared by the cron stage (`fileApproved`) and the admin
 * `file_issue` action, so both apply exactly the same checks:
 *
 *   lease → [expired lease: marker search → link, else release] → current draft and gate from the
 *   CURRENT consented evidence → privacy, evidence, daily cap, tier → marker search → link, cooldown
 *   duplicate, or create
 *
 * The evidence gate (cohort ≥ 3 consenting learners, confidence ≥ 0.75, not withdrawn) binds every path,
 * the operator's included: an operator decision only replaces the risk tier. Every outcome that files
 * nothing releases the lease, so no proposal stays in `filing`; only an ambiguous create (network error or
 * 5xx after the POST) keeps it, and the next attempt after the lease expires looks for the issue first.
 */
import { createGithubIssuePublisher, GithubIssueError, type GithubFetch, type GithubIssuePublisher } from './github-issue-publisher';
import { DAILY_ISSUE_CAP, githubIssuesMode } from './feature-flags';
import type { GateDecision, GateReason } from './insight-types';
import { assessSignal, currentDraft, persistAssessment, readGateEnv, type Assessment } from './proposal-assessment';
import {
  cohortStats, daysBefore, FILEABLE_STATUSES, getProposal, getSignal, leaseForFiling, recordDuplicateOfIssue, recordFiled, releaseFiling,
  releaseIssueSlot, reserveIssueSlot, SIGNAL_WINDOW_DAYS,
} from './proposal-store';

/** A closed issue with the same fingerprint blocks a new one for this many days. */
export const ISSUE_COOLDOWN_DAYS = 30;
const DAY_MS = 86_400_000;

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
  | { kind: 'privacy_blocked' }
  | { kind: 'not_allowed'; gate: GateDecision }
  | { kind: 'daily_cap' }
  | { kind: 'github_error'; status: number };

export interface FileOptions {
  /** True for the admin action: the operator's decision replaces the gate's issue tier (never evidence, privacy or the cap). */
  operator: boolean;
  actor: string;
  publisher?: GithubIssuePublisher | null;
  fetchImpl?: GithubFetch;
}

/** Gate reasons about the evidence itself, which no operator decision can override. */
const EVIDENCE_REASONS: ReadonlySet<GateReason> = new Set(['personal_preference', 'cohort_too_small', 'low_confidence', 'privacy']);

/** Why this assessment may not be filed now, or null when it may. */
function filingRefusal(a: Assessment, operatorApproved: boolean): FilingOutcome | null {
  if (!a.draft) return { kind: 'not_allowed', gate: a.gate };
  if (!a.markdown) return { kind: 'privacy_blocked' };
  if (a.gate.decision === 'none' || a.gate.reasons.some((r) => EVIDENCE_REASONS.has(r))) return { kind: 'not_allowed', gate: a.gate };
  if (a.gate.reasons.includes('daily_cap')) return { kind: 'daily_cap' };
  const autoTier = a.gate.decision === 'issue' || a.gate.decision === 'issue_ai_handle';
  return autoTier || operatorApproved ? null : { kind: 'not_allowed', gate: a.gate };
}

/**
 * Files one proposal (see file header). Exactly one concurrent caller holds the lease, so concurrent
 * filings make at most one POST. `ai-handle` is labelled only under mode `issues_ai_handle` and only when
 * the deterministic gate says `issue_ai_handle` or an operator approval is recorded.
 */
export async function fileProposal(env: Env, proposalId: string, now: Date, opts: FileOptions): Promise<FilingOutcome> {
  const db = env.DB;
  const mode = githubIssuesMode(env);
  const publisher = opts.publisher === undefined ? createGithubIssuePublisher(env, opts.fetchImpl) : opts.publisher;
  if (mode === 'off' || !publisher) return { kind: 'github_off' };

  const p = await getProposal(db, proposalId);
  if (!p) return { kind: 'not_found' };
  if (p.github_issue_number !== null || !FILEABLE_STATUSES.includes(p.status)) return { kind: 'invalid_status' };
  const signal = await getSignal(db, p.signal_id);
  if (!signal) return { kind: 'not_found' };

  if (!(await leaseForFiling(db, p.id, now))) return { kind: 'busy' };
  const prior = p.status;
  let slotReserved = false;
  try {
    if (prior === 'filing') {
      // An earlier attempt crashed or its create was ambiguous, so the issue may already exist: link it
      // whatever the gate says now (it is public either way). Otherwise release; the next attempt starts
      // over with the full checks. A slot kept by an ambiguous create stays counted (conservative).
      const open = (await publisher.searchByFingerprint(signal.fingerprint)).find((i) => i.state === 'open');
      if (open) {
        await recordFiled(db, p.id, { number: open.number, url: open.url, aiHandle: false }, opts.actor, now);
        return { kind: 'linked', number: open.number, url: open.url };
      }
      await releaseFiling(db, p.id, prior, now);
      return { kind: 'released' };
    }

    // Right before filing: the draft and the gate from the evidence that is consented NOW.
    const gateEnv = await readGateEnv(env, now);
    const stats = await cohortStats(db, signal.id, daysBefore(now, SIGNAL_WINDOW_DAYS));
    const state = await currentDraft(db, signal, p.draft_json, stats);
    const a = await assessSignal(db, signal, state.draft, gateEnv, now, { stats });
    const refusal = filingRefusal(a, opts.operator || prior === 'accepted');
    if (refusal) {
      if (state.action !== 'withdraw') await releaseFiling(db, p.id, prior, now);
      await persistAssessment(db, p.id, state, a, now); // a withdrawal also drops the lease
      return refusal;
    }
    if (!a.draft || !a.markdown) throw new Error('unreachable: refusal covers a missing draft or body');
    await persistAssessment(db, p.id, state, a, now);
    const aiHandle = mode === 'issues_ai_handle' && (a.gate.decision === 'issue_ai_handle' || p.ai_handle_approved_by !== null);

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
      // The issue may exist: keep the lease and the slot so the attempt after the lease expires finds it by marker.
      return { kind: 'github_error', status };
    }
    if (slotReserved) await releaseIssueSlot(db, now).catch(() => undefined);
    await releaseFiling(db, p.id, prior, now);
    if (!(err instanceof GithubIssueError)) console.error('insights filing failed', err instanceof Error ? err.name : 'error');
    return { kind: 'github_error', status };
  }
}
