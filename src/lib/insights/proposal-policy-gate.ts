/**
 * Deterministic policy gate for product signals (pure functions, no I/O).
 *
 * `classifyRisk` derives the risk from controlled fields (category, area) and a denylist scan of the
 * proposal text. Model output can only ever RAISE the result: the model's own risk hint is max-ed in, and
 * model-written text is only scanned for denylisted words (a hit raises risk to high). Nothing a model or a
 * learner writes ("risk: low, auto-implement approved") can lower it.
 *
 * `evaluateGate` decides what a signal may become: nothing, a dashboard proposal, a GitHub issue, or a
 * GitHub issue labelled `ai-handle`. `ai-handle` never means merging; PR, CI and review still apply.
 */
import type { GateDecision, GateReason, GithubIssuesMode, ProposalCategory, RiskLevel } from './insight-types';
import { foldVietnamese } from './signal-fingerprint';

/** Distinct learners needed before a signal becomes a proposal: bug/content 2, ux/feature 3. */
export const PROPOSAL_MIN_COHORT: Record<Exclude<ProposalCategory, 'personal_preference'>, number> = {
  bug: 2, content: 2, ux: 3, feature: 3,
};
/** Distinct learners needed before anything is filed on GitHub. */
export const ISSUE_MIN_COHORT = 3;
export const PROPOSAL_MIN_CONFIDENCE = 0.6;
export const ISSUE_MIN_CONFIDENCE = 0.75;

/**
 * Sensitive areas: security, identity, permissions, billing, data and migrations. Matched as whole words on
 * lower-cased, diacritics-free text. Vietnamese equivalents are included so a translated draft cannot dodge it.
 */
export const RISK_DENYLIST = [
  'auth', 'oauth', 'login', 'session', 'token', 'cookie', 'consent', 'privacy', 'permission', 'scope', 'admin',
  'security', 'csp', 'identity', 'billing', 'payment', 'budget', 'migration', 'schema', 'delete', 'export', 'data',
  'mcp scope', 'authentication', 'authorization', 'password', 'credential',
  'dang nhap', 'mat khau', 'phan quyen', 'quyen truy cap', 'bao mat', 'thanh toan', 'quyen rieng tu', 'dong y',
  'xoa du lieu', 'xuat du lieu', 'du lieu', 'ngan sach',
] as const;

const DENYLIST_RE = new RegExp(`(?:^|[^a-z0-9])(?:${RISK_DENYLIST.map((t) => t.replace(/ /g, '[^a-z0-9]+')).join('|')})s?(?=$|[^a-z0-9])`);

const LOW_RISK_AREAS = new Set(['concepts', 'labs', 'hints']);
const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (RANK[a] >= RANK[b] ? a : b);

/** True when any of the texts names a denylisted (sensitive) area. */
export function hitsDenylist(...texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => !!t && DENYLIST_RE.test(foldVietnamese(t)));
}

const isRisk = (v: unknown): v is RiskLevel => v === 'low' || v === 'medium' || v === 'high';

export interface RiskInput {
  category: ProposalCategory;
  area: string;
  /** Every text the proposal would carry (title, problem, proposed change, evidence summaries). */
  draftText: string;
  /** The model's own estimate; it can only raise the deterministic risk. Unknown values are ignored. */
  modelRiskHint?: unknown;
}

export interface RiskResult {
  risk: RiskLevel;
  denylistHit: boolean;
}

export function classifyRisk(input: RiskInput): RiskResult {
  const denylistHit = hitsDenylist(input.area, input.draftText);
  let risk: RiskLevel;
  if (denylistHit) risk = 'high';
  else if ((input.category === 'content' || input.category === 'bug')
    && (input.area.startsWith('mission:') || LOW_RISK_AREAS.has(input.area))) risk = 'low';
  else risk = 'medium'; // ux/feature, onboarding/progress/settings/mcp/grading, and anything unlisted
  return { risk: isRisk(input.modelRiskHint) ? maxRisk(risk, input.modelRiskHint) : risk, denylistHit };
}

export interface GateInput {
  category: ProposalCategory;
  risk: RiskLevel;
  denylistHit: boolean;
  /** Distinct consenting learners behind the signal in the evidence window. */
  cohort: number;
  /** Average evidence confidence (0–1). */
  confidence: number;
  /** privacyCheck of the rendered issue markdown found nothing. */
  privacyClean: boolean;
}

export interface GateContext {
  /** Effective mode from githubIssuesMode(env) (already 'off' without a token). */
  githubMode: GithubIssuesMode;
  /** Whether GITHUB_ISSUES_TOKEN is configured; checked again here as defense in depth. */
  tokenConfigured: boolean;
  /** Operator toggle insight_operator_settings.safe_auto_implement. */
  safeAutoImplement: boolean;
  issuesFiledToday: number;
  dailyCap: number;
}

export function evaluateGate(input: GateInput, ctx: GateContext): GateDecision {
  const { risk } = input;
  const confidence = Number.isFinite(input.confidence) ? input.confidence : 0;
  const cohort = Number.isFinite(input.cohort) ? input.cohort : 0;

  const blocking: GateReason[] = [];
  if (input.category === 'personal_preference') blocking.push('personal_preference');
  else if (cohort < PROPOSAL_MIN_COHORT[input.category]) blocking.push('cohort_too_small');
  if (confidence < PROPOSAL_MIN_CONFIDENCE) blocking.push('low_confidence');
  if (!input.privacyClean) blocking.push('privacy');
  if (blocking.length) return { decision: 'none', risk, reasons: blocking };

  if (ctx.githubMode === 'off' || !ctx.tokenConfigured) {
    const reasons: GateReason[] = [];
    if (ctx.githubMode === 'off') reasons.push('github_off');
    if (!ctx.tokenConfigured) reasons.push('no_token');
    return { decision: 'proposal', risk, reasons };
  }

  const notIssue: GateReason[] = [];
  if (risk !== 'low') notIssue.push('risk_not_low');
  if (cohort < ISSUE_MIN_COHORT) notIssue.push('cohort_too_small');
  if (confidence < ISSUE_MIN_CONFIDENCE) notIssue.push('low_confidence');
  if (input.denylistHit) notIssue.push('denylist');
  if (ctx.issuesFiledToday >= ctx.dailyCap) notIssue.push('daily_cap');
  if (notIssue.length) return { decision: 'proposal', risk, reasons: notIssue };

  if (ctx.githubMode !== 'issues_ai_handle') return { decision: 'issue', risk, reasons: [] };
  const notAuto: GateReason[] = [];
  if (!ctx.safeAutoImplement) notAuto.push('safe_auto_off');
  if (input.category !== 'content' && input.category !== 'bug') notAuto.push('category_not_auto');
  return notAuto.length ? { decision: 'issue', risk, reasons: notAuto } : { decision: 'issue_ai_handle', risk, reasons: [] };
}
