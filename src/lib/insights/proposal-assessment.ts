/**
 * Fresh assessment of a signal's proposal: which draft may still be shown or filed, and what the policy gate
 * says about it right now. Shared by the cron stage, the filing path and the admin detail view, so every
 * reader sees the same answer computed from the CURRENT consented evidence.
 *
 * Draft freshness (`currentDraft`) is about the text: a draft stands only while the signal still has the
 * minimum consented cohort (at any age) and every report it was written from is still consented evidence.
 * Otherwise it is rebuilt from the evidence-free template, or withdrawn when the cohort is gone.
 * Fileability is about the gate, computed over the 14-day evidence window.
 */
import { DAILY_ISSUE_CAP, githubIssuesMode } from './feature-flags';
import { githubTokenConfigured } from './github-issue-publisher';
import type { GateDecision, GithubIssuesMode } from './insight-types';
import { draftRiskHint, draftRiskText, parseStoredDraft, prepareIssue, templateDraft, type IssueDraft } from './issue-draft';
import { getSafeAutoImplement } from './operator-settings';
import { classifyRisk, evaluateGate, PROPOSAL_MIN_COHORT } from './proposal-policy-gate';
import {
  cohortStats, consentedEvidence, contributorNames, daysBefore, evidenceStillConsented, issuesFiledToday, SIGNAL_WINDOW_DAYS,
  updateProposalDraft, updateProposalGate, withdrawProposalDraft, WITHDRAWN_DRAFT_JSON, type CohortStats, type SignalRow,
} from './proposal-store';

export interface GateEnv {
  githubMode: GithubIssuesMode;
  tokenConfigured: boolean;
  safeAutoImplement: boolean;
  issuesFiledToday: number;
}

/** Mode, token presence, operator toggle and today's issue count (two D1 queries). */
export async function readGateEnv(env: Env, now: Date): Promise<GateEnv> {
  return {
    githubMode: githubIssuesMode(env),
    tokenConfigured: githubTokenConfigured(env),
    safeAutoImplement: await getSafeAutoImplement(env.DB),
    issuesFiledToday: await issuesFiledToday(env.DB, now),
  };
}

export interface Assessment {
  /** Null when the draft was withdrawn with its evidence. */
  draft: IssueDraft | null;
  /** Rendered, privacy-checked issue body; null when blocked by the privacy check or withdrawn. */
  markdown: string | null;
  privacyHits: string[];
  stats: CohortStats;
  gate: GateDecision;
}

/**
 * Current cohort, privacy check, deterministic risk and gate for a signal and its draft. Risk is computed
 * from controlled fields plus a denylist scan of every draft text; the model's hint and text only raise it.
 * A null draft (withdrawn) is gated on the template so the reasons stay meaningful, but has no markdown.
 */
export async function assessSignal(
  db: D1Database, signal: SignalRow, draft: IssueDraft | null, gateEnv: GateEnv, now: Date, known?: { stats?: CohortStats; evidence?: string[] },
): Promise<Assessment> {
  const since = daysBefore(now, SIGNAL_WINDOW_DAYS);
  const stats = known?.stats ?? await cohortStats(db, signal.id, since);
  const evidence = known?.evidence ?? (await consentedEvidence(db, signal.id, since)).map((e) => e.text);
  const subject = draft ?? templateDraft(signal, stats);
  const prepared = prepareIssue(subject, signal, stats, evidence, await contributorNames(db, signal.id));
  const { risk, denylistHit } = classifyRisk({
    category: signal.category,
    area: signal.area,
    draftText: [signal.title, draftRiskText(subject), draftRiskText(prepared.draft), ...evidence].join('\n'),
    modelRiskHint: draftRiskHint(subject),
  });
  const gate = evaluateGate(
    { category: signal.category, risk, denylistHit, cohort: stats.learners, confidence: stats.avgConfidence, privacyClean: prepared.privacy.ok },
    { ...gateEnv, dailyCap: DAILY_ISSUE_CAP },
  );
  if (!draft) return { draft: null, markdown: null, privacyHits: prepared.privacy.hits, stats, gate };
  return { draft: prepared.draft, markdown: prepared.markdown, privacyHits: prepared.privacy.hits, stats, gate };
}

/** What happens to a stored draft: kept, replaced by the evidence-free template, or withdrawn. */
export interface DraftState {
  draft: IssueDraft | null;
  action: 'keep' | 'replace' | 'withdraw';
}

/**
 * The draft a proposal may carry right now (see file header). `windowStats` sizes the template's counts.
 * Read-only: callers persist the action with `persistDraftState`.
 */
export async function currentDraft(db: D1Database, signal: SignalRow, storedJson: string | null, windowStats: CohortStats): Promise<DraftState> {
  const withdrawn = storedJson === WITHDRAWN_DRAFT_JSON;
  const everyone = await cohortStats(db, signal.id, '');
  if (everyone.learners < PROPOSAL_MIN_COHORT) return { draft: null, action: withdrawn ? 'keep' : 'withdraw' };
  const stored = parseStoredDraft(storedJson);
  if (stored && await evidenceStillConsented(db, signal.id, stored.basis)) return { draft: stored, action: 'keep' };
  return { draft: templateDraft(signal, windowStats), action: 'replace' };
}

/**
 * Persists a draft state and the fresh gate of an assessment. A withdrawal also returns the proposal to a
 * non-fileable `proposed`; a privacy-driven template swap (`a.draft` differs) is stored like a replacement.
 */
export async function persistAssessment(db: D1Database, proposalId: string, state: DraftState, a: Assessment, now: Date): Promise<void> {
  if (state.action === 'withdraw' || !a.draft) {
    if (state.action === 'withdraw') await withdrawProposalDraft(db, proposalId, a.gate, now);
    else await updateProposalGate(db, proposalId, a.gate, now);
    return;
  }
  await updateProposalGate(db, proposalId, a.gate, now);
  if (state.action === 'replace' || a.draft !== state.draft) await updateProposalDraft(db, proposalId, JSON.stringify(a.draft), now);
}
