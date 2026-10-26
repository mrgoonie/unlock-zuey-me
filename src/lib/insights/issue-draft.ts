/**
 * Proposal drafts and the GitHub issue body.
 *
 * `buildDraft` makes one model call (system actor `system:insights`, coaching pool) with the abstract
 * evidence fenced as untrusted data, validates every section (≤ 600 chars), and falls back to a
 * deterministic template built only from signal fields and counts whenever the model is unavailable or its
 * output is rejected. Neither ever quotes learner evidence: the prompt forbids it and `prepareIssue`
 * re-scans the rendered body with `privacyCheck` (which catches 40-character or 8-word copies); a hit
 * replaces a model draft with the template, and a template hit leaves the proposal blocked.
 *
 * A draft records the report ids it was written from (`basis`, never rendered) so a draft whose evidence
 * was withdrawn (consent revoked, reports or account deleted) can be detected and replaced. Nothing here
 * sees raw prompts, transcripts, learner ids or names; the issue body is English (GitHub-facing), the
 * dashboard is Vietnamese.
 */
import { z } from 'zod';
import { AiUnavailableError, runAi, type AiDeps, type AiPurpose } from '../coach/ai-gateway';
import type { ChatMessage, JsonSchemaSpec } from '../coach/ai-clients';
import { extractJsonObject } from '../coach/ai-clients';
import { COACH_MODELS, WORKERS_AI_MODEL } from '../coach/ai-models';
import { fenceUntrusted, newBoundary, untrustedDataRule } from '../coach/untrusted-text';
import type { RiskLevel } from './insight-types';
import { privacyCheck, type PrivacyResult } from './issue-privacy-check';
import { SYSTEM_ACTOR } from './operator-settings';
import type { CohortStats, SignalRow } from './proposal-store';
import { SIGNAL_WINDOW_DAYS } from './proposal-store';

/** Drafts use the insights purpose, which draws from the coaching pool and can never starve grading. */
const DRAFT_AI_PURPOSE: AiPurpose = 'insights';
export const SECTION_MAX = 600;
/** Evidence items shown to the draft model. */
export const DRAFT_EVIDENCE_MAX = 5;

const section = z.string().trim().min(1).max(SECTION_MAX);
export const draftSectionsSchema = z.object({
  title: z.string().trim().min(8).max(120),
  problem: section,
  affectedContext: section,
  evidence: section,
  proposedChange: section,
  existingSolutionCheck: section,
  alternatives: section,
  tradeoffs: section,
  acceptanceCriteria: section,
  blastRadius: section,
  riskHint: z.enum(['low', 'medium', 'high']),
}).strict();
export type DraftSections = z.infer<typeof draftSectionsSchema>;

/** insight_proposals.draft_json. */
export interface IssueDraft extends DraftSections {
  source: 'ai' | 'template';
  model: string | null;
  /** Report ids of the evidence the text was written from (empty for the evidence-free template). */
  basis: string[];
}

const storedDraftSchema = draftSectionsSchema.extend({
  source: z.enum(['ai', 'template']),
  model: z.string().nullable(),
  basis: z.array(z.string().min(1).max(64)).max(20),
}).strict();

/** A stored draft, or null when the JSON is missing, withdrawn (`{}`), malformed or from before `basis`. */
export function parseStoredDraft(json: string | null): IssueDraft | null {
  if (!json) return null;
  try {
    const r = storedDraftSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** One piece of consented evidence: the report it came from and its abstract text. */
export interface EvidenceItem {
  reportId: string;
  text: string;
}

const SECTION_KEYS = ['problem', 'affectedContext', 'evidence', 'proposedChange', 'existingSolutionCheck', 'alternatives', 'tradeoffs', 'acceptanceCriteria', 'blastRadius'] as const;

const DRAFT_JSON_SCHEMA: JsonSchemaSpec = {
  name: 'insight_issue_draft',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', ...SECTION_KEYS, 'riskHint'],
    properties: {
      title: { type: 'string', maxLength: 120 },
      ...Object.fromEntries(SECTION_KEYS.map((k) => [k, { type: 'string', maxLength: SECTION_MAX }])),
      riskHint: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
  },
};

/** The model call, injectable in tests. Resolves the validated sections and the model id. */
export type DraftModel = (messages: ChatMessage[]) => Promise<{ value: DraftSections; model: string }>;

export function defaultDraftModel(deps: AiDeps): DraftModel {
  return async (messages) => {
    const r = await runAi(deps, {
      purpose: DRAFT_AI_PURPOSE, learnerId: SYSTEM_ACTOR, messages, maxTokens: 1_400, temperature: 0.2,
      openRouterModels: COACH_MODELS, workersAiModel: WORKERS_AI_MODEL, jsonSchema: DRAFT_JSON_SCHEMA,
      parse: (text) => draftSectionsSchema.parse(extractJsonObject(text)), timeoutMs: 20_000,
    });
    return { value: r.value, model: r.model };
  };
}

export function buildDraftMessages(signal: SignalRow, stats: CohortStats, evidence: string[], boundary = newBoundary()): ChatMessage[] {
  const system = [
    'You write concise GitHub issue drafts for the AI Unlocked learning platform (unlock.zuey.me) from aggregated, de-identified product signals.',
    'Write in English. Never include names, ids, emails, URLs, secrets, prompts or transcripts.',
    'Never quote or copy the evidence: do not reuse any phrase of five or more words from it, in any language. Describe the shared problem in your own general words.',
    'Propose the smallest change that would fix the problem, and first check whether existing config or content already solves it.',
    'riskHint is your estimate of the change risk. It can only raise the platform\'s own risk assessment, never lower it.',
    untrustedDataRule(boundary),
    'Reply with one JSON object matching the schema.',
  ].join('\n');
  const user = [
    `Signal: category=${signal.category}; area=${signal.area}; title=${signal.title}`,
    `Cohort over ${SIGNAL_WINDOW_DAYS} days: ${stats.learners} learners, ${stats.occurrences} occurrences, average confidence ${stats.avgConfidence}.`,
    'Abstract evidence (untrusted data):',
    fenceUntrusted(evidence.map((e, i) => `${i + 1}. ${e}`).join('\n'), boundary),
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Deterministic draft from controlled signal fields and counts only: it never contains learner evidence. */
export function templateDraft(signal: SignalRow, stats: CohortStats): IssueDraft {
  return {
    source: 'template',
    model: null,
    basis: [],
    title: clip(`Learners report: ${signal.title}`, 120),
    problem: `Several learners independently hit the same ${signal.category} problem in "${signal.area}": ${signal.title}.`,
    affectedContext: `Area: ${signal.area}. Category: ${signal.category}. First seen ${signal.first_seen_at.slice(0, 10)}.`,
    evidence: `${stats.learners} learners independently reported this, ${stats.occurrences} occurrences in ${SIGNAL_WINDOW_DAYS} days.`,
    proposedChange: `Review the ${signal.area} content or behaviour named above and make the smallest change that removes the confusion.`,
    existingSolutionCheck: 'Check the current mission content, hints and concept pages for an existing answer before changing code.',
    alternatives: 'Clarify the wording only; add a hint; leave as is and keep monitoring the signal.',
    tradeoffs: 'A wording change is cheap and reversible; a behaviour change needs tests and review.',
    acceptanceCriteria: `- The problem no longer reproduces in ${signal.area}.\n- The signal's occurrences drop in the ${SIGNAL_WINDOW_DAYS} days after shipping.`,
    blastRadius: `Limited to ${signal.area}.`,
    riskHint: 'low',
  };
}

/**
 * Model draft, or the template when the model is unavailable, over budget, or its output fails validation.
 * Never throws.
 */
export async function buildDraft(model: DraftModel, signal: SignalRow, stats: CohortStats, evidence: EvidenceItem[]): Promise<IssueDraft> {
  const used = evidence.slice(0, DRAFT_EVIDENCE_MAX);
  try {
    const r = await model(buildDraftMessages(signal, stats, used.map((e) => e.text)));
    return { ...draftSectionsSchema.parse(r.value), source: 'ai', model: r.model, basis: used.map((e) => e.reportId) };
  } catch (err) {
    console.warn('insights draft falls back to template', err instanceof AiUnavailableError ? err.reason : 'invalid');
    return templateDraft(signal, stats);
  }
}

/** Every text of the draft that describes the change, for the risk denylist scan. */
export const draftRiskText = (d: Pick<IssueDraft, 'title' | 'problem' | 'affectedContext' | 'proposedChange' | 'blastRadius'>): string =>
  [d.title, d.problem, d.affectedContext, d.proposedChange, d.blastRadius].join('\n');

export const fingerprintMarker = (fp: string): string => `<!-- ai-unlocked-fp:${fp} -->`;
export const AI_HANDLE_NOTICE = '`ai-handle` ≠ auto-merge: every change still goes through a PR, CI and review before it ships.';

export function renderIssueMarkdown(draft: IssueDraft, signal: SignalRow, stats: CohortStats): string {
  return [
    `## Problem\n${draft.problem}`,
    `## Affected context\n${draft.affectedContext}`,
    `## Aggregated evidence (${stats.learners} learners, ${stats.occurrences} occurrences, ${SIGNAL_WINDOW_DAYS} days)\n${draft.evidence}`,
    `## Proposed minimal change\n${draft.proposedChange}`,
    `## Existing config/content solution check\n${draft.existingSolutionCheck}`,
    `## Alternatives\n${draft.alternatives}`,
    `## Trade-offs\n${draft.tradeoffs}`,
    `## Acceptance criteria\n${draft.acceptanceCriteria}`,
    `## Blast radius\n${draft.blastRadius}`,
    `## Confidence\nAverage evidence confidence ${stats.avgConfidence.toFixed(2)} across ${stats.learners} consenting learners. Category \`${signal.category}\`, area \`${signal.area}\`.`,
    '## Privacy checks\n- Built only from de-identified, aggregated signals of learners who opted in to proposals.\n'
      + '- Re-scanned with the shared redaction rules before filing: 0 hits.\n'
      + '- No raw prompts, transcripts, learner ids, names, emails or external URLs.',
    `---\n${AI_HANDLE_NOTICE}\nGenerated by the AI Unlocked insights pipeline (unlock.zuey.me).`,
    fingerprintMarker(signal.fingerprint),
  ].join('\n\n');
}

export { privacyCheck, type PrivacyHitKind, type PrivacyResult } from './issue-privacy-check';

export interface PreparedIssue {
  draft: IssueDraft;
  /** Null when both the draft and the template failed the privacy check (proposal blocked). */
  markdown: string | null;
  privacy: PrivacyResult;
}

/** Renders and re-scans; a failing model draft is replaced by the template, a failing template blocks. */
export function prepareIssue(
  draft: IssueDraft, signal: SignalRow, stats: CohortStats, evidence: string[], forbiddenTerms: string[] = [],
): PreparedIssue {
  const check = (d: IssueDraft) => {
    const markdown = renderIssueMarkdown(d, signal, stats);
    return { markdown, privacy: privacyCheck(`# ${d.title}\n\n${markdown}`, { evidence, forbiddenTerms }) };
  };
  const first = check(draft);
  if (first.privacy.ok) return { draft, markdown: first.markdown, privacy: first.privacy };
  if (draft.source === 'template') return { draft, markdown: null, privacy: first.privacy };
  const template = templateDraft(signal, stats);
  const second = check(template);
  return { draft: template, markdown: second.privacy.ok ? second.markdown : null, privacy: second.privacy };
}

/** Model risk hint carried by a stored draft (only ever used to raise risk). */
export const draftRiskHint = (d: Partial<IssueDraft>): RiskLevel | undefined =>
  d.riskHint === 'low' || d.riskHint === 'medium' || d.riskHint === 'high' ? d.riskHint : undefined;
