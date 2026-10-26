/**
 * Shared types of the ai-tutor insights feature (#25). Every phase codes against these; the D1 schema they
 * mirror is migrations/0008_insights.sql and the ingest wire format is ingest-contract.ts.
 *
 * ai-tutor is a server-side background analyzer (one structured LLM call per session window), not a
 * Claude Code subagent. Reports hold only what the events show; the model's hidden reasoning is never
 * available and never claimed.
 */
import type { CompetencyId } from '../content/schema';
import type { CronBudget } from '../jobs/cron-budget';

export type { IngestAdapter, IngestTurnV1 } from './ingest-contract';

/** INSIGHTS_MODE: off (default) → nothing; internal → admins; pilot → admins + INSIGHTS_PILOT_EMAILS; on → members. */
export type InsightsMode = 'off' | 'internal' | 'pilot' | 'on';
export const INSIGHTS_MODES: readonly InsightsMode[] = ['off', 'internal', 'pilot', 'on'];

/** INSIGHTS_GITHUB_ISSUES, forced to 'off' whenever GITHUB_ISSUES_TOKEN is missing. */
export type GithubIssuesMode = 'off' | 'issues' | 'issues_ai_handle';
export const GITHUB_ISSUES_MODES: readonly GithubIssuesMode[] = ['off', 'issues', 'issues_ai_handle'];

/** The three separate opt-ins (insight_consents), all off by default and independent of observer_consent. */
export type InsightConsentKind = 'analysis' | 'share_operator' | 'proposals';

export interface InsightConsents {
  /** Personal analysis: turns may be uploaded and analysed into the learner's own reports. */
  analysis: boolean;
  /** Detailed reports visible to operators (also requires learners.observer_consent = 1). */
  shareOperator: boolean;
  /** Processed product observations may feed de-identified proposals. */
  proposals: boolean;
  analysisAt: string | null;
  shareOperatorAt: string | null;
  proposalsAt: string | null;
  updatedAt: string | null;
}

export const NO_INSIGHT_CONSENTS: InsightConsents = {
  analysis: false, shareOperator: false, proposals: false,
  analysisAt: null, shareOperatorAt: null, proposalsAt: null, updatedAt: null,
};

/** insight_events.status. */
export type InsightEventStatus = 'pending' | 'processing' | 'done' | 'skipped' | 'dead';

/** insight_events.skip_reason. */
export type InsightSkipReason =
  | 'trivial' // no prompt and a very short reply, or a tiny prompt without tools
  | 'duplicate' // same content already in the window
  | 'no_value' // nothing left after filtering
  | 'not_learning' // the analyzer judged the window irrelevant to learning
  | 'quota_session' // per-session daily analysis cap reached
  | 'stale'; // still pending 48 h after it was received

/** Learner-facing competency ids double as the report's skill tags. */
export type InsightSkill = CompetencyId;

/** Product areas a signal can point at. `mission:<id>` must name an existing mission. */
export type InsightArea =
  | 'mcp' | 'hints' | 'grading' | 'labs' | 'concepts' | 'onboarding' | 'settings' | 'progress' | 'other'
  | `mission:${string}`;
export const INSIGHT_FIXED_AREAS = ['mcp', 'hints', 'grading', 'labs', 'concepts', 'onboarding', 'settings', 'progress', 'other'] as const;

/** What the analyzer may classify an observation as. personal_preference never becomes a signal. */
export type ProposalCategory = 'bug' | 'content' | 'ux' | 'feature' | 'personal_preference';
/** insight_signals.category: the categories that can become a product signal. */
export type SignalCategory = Exclude<ProposalCategory, 'personal_preference'>;

export type RiskLevel = 'low' | 'medium' | 'high';

/** insight_proposals.status (triage workflow). */
export type ProposalStatus =
  | 'proposed' | 'duplicate' | 'accepted' | 'rejected' | 'filing' | 'issue_filed' | 'shipped' | 'monitored';

/** Evidence references point at the window's events, labelled e1…eN in the prompt. */
export type EvidenceRef = `e${number}`;

export type RiskSignalKind = 'unverified_claim' | 'sensitive_data_shared' | 'overreliance' | 'tool_error_ignored';

/** Only when the events show interaction with unlock.zuey.me or its MCP tools. */
export interface ProductObservation {
  category: ProposalCategory;
  area: InsightArea;
  /** Short slug naming the topic (≤ 48 chars); normalised into the signal fingerprint. */
  topic_key: string;
  /** Abstracted description, no quotes from the learner (≤ 240 chars). */
  summary: string;
  evidence_ref: EvidenceRef;
  confidence: number;
}

/** Validated analyzer output (snake_case: it is the model's JSON schema). */
export interface AiTutorReport {
  /** False → the window is skipped as `not_learning` and no report row is written. */
  relevant: boolean;
  intent_summary: { text: string; confidence: number };
  workflow_observed: Array<{ step: string; evidence_ref: EvidenceRef }>;
  learning_insights: Array<{ skill: InsightSkill; note: string }>;
  verification_gaps: Array<{ note: string; evidence_ref: EvidenceRef }>;
  risk_signals: Array<{ kind: RiskSignalKind; note: string; evidence_ref: EvidenceRef }>;
  next_best_action: { text: string; mission_id?: string } | null;
  product_observation: ProductObservation | null;
  confidence: number;
}

/** insight_reports.report_json: the validated report plus its provenance. */
export interface StoredAiTutorReport extends AiTutorReport {
  source_runtime: string;
  created_at: string;
  model: string;
  prompt_version: number;
  /** Every ref the report cites, all of them ids of the analysed window. */
  evidence_refs: EvidenceRef[];
}

/** Policy gate outcome for one signal. */
export type GateDecisionKind = 'none' | 'proposal' | 'issue' | 'issue_ai_handle';

/** Why the gate chose a weaker outcome than `issue_ai_handle`. */
export type GateReason =
  | 'personal_preference'
  | 'cohort_too_small'
  | 'low_confidence'
  | 'privacy'
  | 'github_off'
  | 'no_token'
  | 'risk_not_low'
  | 'category_not_auto'
  | 'denylist'
  | 'safe_auto_off'
  | 'daily_cap';

/** insight_proposals.gate_json. Risk is computed deterministically; model text can only raise it. */
export interface GateDecision {
  decision: GateDecisionKind;
  risk: RiskLevel;
  reasons: GateReason[];
}

/** Cron stage signature (pipeline-job.ts runs retention → analyzer → proposal). */
export type InsightsStage = (env: Env, budget: CronBudget, now: Date) => Promise<unknown>;

/** Outcome of one stage inside a pipeline run. */
export type InsightsStageOutcome =
  | { status: 'ok'; result: unknown }
  | { status: 'failed'; error: string }
  | { status: 'deferred' };

export type InsightsPipelineResult =
  | { skipped: 'flag_off' }
  | { mode: Exclude<InsightsMode, 'off'>; retention: InsightsStageOutcome; analyzer: InsightsStageOutcome; proposal: InsightsStageOutcome };
