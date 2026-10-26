/**
 * Output contract of the ai-tutor analyzer (a server-side background analyzer: one structured LLM call per
 * session window, no tools). The model gets the JSON schema below. Its output then goes through zod and
 * these server checks:
 * - every `evidence_ref` must be one of the window's event ids (e1…eN); an item citing anything else is
 *   dropped (a product observation with a bad ref becomes null);
 * - `mission_id` and `mission:<id>` areas must name a published mission;
 * - any claim of access to the model's hidden reasoning / chain-of-thought rejects the whole output, so the
 *   gateway moves on to the next model. Reports may only describe observable events.
 * Confidence is required on the report, the intent summary and any product observation; the stored row
 * also carries provenance (`storedAiTutorReportSchema`).
 */
import { z } from 'zod';
import { extractJsonObject, type JsonSchemaSpec } from '../coach/ai-clients';
import { COMPETENCIES } from '../content/schema';
import {
  INSIGHT_FIXED_AREAS,
  type AiTutorReport, type EvidenceRef, type InsightArea, type ProductObservation, type StoredAiTutorReport,
} from './insight-types';

/** Bumped whenever the prompt or schema changes meaningfully; stored on every report. */
export const PROMPT_VERSION = 1;

export const RISK_SIGNAL_KINDS = ['unverified_claim', 'sensitive_data_shared', 'overreliance', 'tool_error_ignored'] as const;
export const PROPOSAL_CATEGORIES = ['bug', 'content', 'ux', 'feature', 'personal_preference'] as const;

/** Claims of seeing a model's hidden reasoning (English and Vietnamese). Any match rejects the output. */
export const FORBIDDEN_REASONING_CLAIM =
  /chain[- ]of[- ]thought|hidden reasoning|reasoning trace|suy (nghĩ|luận) (ẩn|nội bộ)|chuỗi suy (nghĩ|luận) (của|bên trong) (mô hình|ai|claude)/i;

export class AiTutorReportError extends Error {}

/** Evidence refs of a window with `count` events: e1…eN. */
export const windowRefs = (count: number): EvidenceRef[] => Array.from({ length: count }, (_, i) => `e${i + 1}` as EvidenceRef);

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const confidence = z.number().refine(Number.isFinite, 'confidence must be finite').transform(clamp01);
/** Over-long model text is cut rather than rejected (a rejection would cost another model call). */
const text = (max: number) => z.string().trim().min(1).transform((s) => s.slice(0, max));
const topicKey = z.string().trim().toLowerCase().max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'topic slug');

export interface ReportCheckContext {
  /** Ids of the analysed window (e1…eN). */
  refs: readonly string[];
  /** Ids of published missions (content loader). */
  missionIds: ReadonlySet<string>;
}

function itemSchemas(ctx: ReportCheckContext) {
  const ref = z.string().refine((r) => ctx.refs.includes(r), 'unknown evidence_ref').transform((r) => r as EvidenceRef);
  const area = z.string().refine(
    (a) => (INSIGHT_FIXED_AREAS as readonly string[]).includes(a) || (a.startsWith('mission:') && ctx.missionIds.has(a.slice(8))),
    'unknown area',
  ).transform((a) => a as InsightArea);
  return {
    workflow: z.object({ step: text(160), evidence_ref: ref }),
    learning: z.object({ skill: z.enum(COMPETENCIES), note: text(200) }),
    gap: z.object({ note: text(200), evidence_ref: ref }),
    risk: z.object({ kind: z.enum(RISK_SIGNAL_KINDS), note: text(200), evidence_ref: ref }),
    observation: z.object({
      category: z.enum(PROPOSAL_CATEGORIES),
      area,
      topic_key: topicKey,
      summary: text(240),
      evidence_ref: ref,
      confidence,
    }),
  };
}

/** Top-level shape: every field is required (confidence included); list items are validated one by one. */
const envelopeSchema = z.object({
  relevant: z.boolean(),
  intent_summary: z.object({ text: text(200), confidence }),
  workflow_observed: z.array(z.unknown()),
  learning_insights: z.array(z.unknown()),
  verification_gaps: z.array(z.unknown()),
  risk_signals: z.array(z.unknown()),
  next_best_action: z.object({ text: text(200), mission_id: z.string().nullish() }).nullable(),
  product_observation: z.unknown().nullable(),
  confidence,
});

/** Keeps the items that pass `schema` (in order) up to `max`; invalid ones are dropped, not fatal. */
function keepValid<T>(items: unknown[], schema: z.ZodType<T>, max: number): T[] {
  const out: T[] = [];
  for (const item of items) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    if (out.length >= max) break;
  }
  return out;
}

/** Throws when any text field claims insight into hidden reasoning. */
export function assertNoReasoningClaims(value: unknown): void {
  if (FORBIDDEN_REASONING_CLAIM.test(JSON.stringify(value))) {
    throw new AiTutorReportError('report claims access to hidden reasoning');
  }
}

/** Validates an already-parsed object against the schema and the server checks. */
export function validateAiTutorReport(raw: unknown, ctx: ReportCheckContext): AiTutorReport {
  assertNoReasoningClaims(raw);
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) throw new AiTutorReportError(`invalid report: ${env.error.issues[0]?.message ?? 'schema'}`);
  const o = env.data;
  const s = itemSchemas(ctx);
  const obs = o.product_observation === null ? null : s.observation.safeParse(o.product_observation);
  const nba = o.next_best_action;
  const report: AiTutorReport = {
    relevant: o.relevant,
    intent_summary: o.intent_summary,
    workflow_observed: keepValid(o.workflow_observed, s.workflow, 6),
    learning_insights: keepValid(o.learning_insights, s.learning, 3),
    verification_gaps: keepValid(o.verification_gaps, s.gap, 3),
    risk_signals: keepValid(o.risk_signals, s.risk, 3),
    next_best_action: nba
      ? { text: nba.text, ...(nba.mission_id && ctx.missionIds.has(nba.mission_id) ? { mission_id: nba.mission_id } : {}) }
      : null,
    product_observation: obs?.success ? (obs.data as ProductObservation) : null,
    confidence: o.confidence,
  };
  return report;
}

/** Parses raw model text; throws (so the gateway tries the next model) on anything unusable. */
export function parseAiTutorReport(text: string, ctx: ReportCheckContext): AiTutorReport {
  return validateAiTutorReport(extractJsonObject(text), ctx);
}

/** Every evidence ref a report cites, in window order. */
export function citedRefs(report: AiTutorReport): EvidenceRef[] {
  const refs = new Set<EvidenceRef>();
  for (const i of report.workflow_observed) refs.add(i.evidence_ref);
  for (const i of report.verification_gaps) refs.add(i.evidence_ref);
  for (const i of report.risk_signals) refs.add(i.evidence_ref);
  if (report.product_observation) refs.add(report.product_observation.evidence_ref);
  return [...refs].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** Stored report: the validated report plus required provenance. */
export const storedAiTutorReportSchema = z.object({
  relevant: z.literal(true),
  intent_summary: z.object({ text: z.string().min(1), confidence: z.number().min(0).max(1) }),
  confidence: z.number().min(0).max(1),
  source_runtime: z.string().min(1),
  created_at: z.iso.datetime(),
  model: z.string().min(1),
  prompt_version: z.number().int().min(1),
  evidence_refs: z.array(z.string().regex(/^e\d+$/)),
}).loose();

/** Attaches provenance and checks it; throws when anything required is missing. */
export function buildStoredReport(
  report: AiTutorReport,
  provenance: { sourceRuntime: string; createdAt: string; model: string },
): StoredAiTutorReport {
  const stored: StoredAiTutorReport = {
    ...report,
    source_runtime: provenance.sourceRuntime,
    created_at: provenance.createdAt,
    model: provenance.model,
    prompt_version: PROMPT_VERSION,
    evidence_refs: citedRefs(report),
  };
  const r = storedAiTutorReportSchema.safeParse(stored);
  if (!r.success) throw new AiTutorReportError(`report provenance invalid: ${r.error.issues[0]?.message ?? 'schema'}`);
  return stored;
}

/** JSON schema sent to the model (strict structured output where the provider supports it). */
export function aiTutorJsonSchema(refs: readonly string[], missionIds: readonly string[]): JsonSchemaSpec {
  const str = (description?: string) => (description ? { type: 'string', description } : { type: 'string' });
  const ref = { type: 'string', enum: [...refs], description: 'Id of the event this item is based on' };
  const conf = { type: 'number', description: '0 = guess, 1 = directly shown by the events' };
  const obj = (properties: Record<string, unknown>) => ({
    type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
  });
  const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
  return {
    name: 'ai_tutor_report',
    schema: obj({
      relevant: { type: 'boolean', description: 'false when the events show no learning or AI-use activity worth a report' },
      intent_summary: obj({ text: str('≤ 200 chars, Vietnamese'), confidence: conf }),
      workflow_observed: { type: 'array', maxItems: 6, items: obj({ step: str('≤ 160 chars'), evidence_ref: ref }) },
      learning_insights: { type: 'array', maxItems: 3, items: obj({ skill: { type: 'string', enum: [...COMPETENCIES] }, note: str('≤ 200 chars') }) },
      verification_gaps: { type: 'array', maxItems: 3, items: obj({ note: str('≤ 200 chars'), evidence_ref: ref }) },
      risk_signals: {
        type: 'array', maxItems: 3,
        items: obj({ kind: { type: 'string', enum: [...RISK_SIGNAL_KINDS] }, note: str('≤ 200 chars'), evidence_ref: ref }),
      },
      next_best_action: nullable(obj({
        text: str('≤ 200 chars'),
        mission_id: nullable({ type: 'string', enum: [...missionIds] }),
      })),
      product_observation: nullable(obj({
        category: { type: 'string', enum: [...PROPOSAL_CATEGORIES] },
        area: { type: 'string', enum: [...INSIGHT_FIXED_AREAS, ...missionIds.map((id) => `mission:${id}`)] },
        topic_key: str('lowercase kebab-case slug, ≤ 48 chars'),
        summary: str('≤ 240 chars, abstracted, no quotes from the learner'),
        evidence_ref: ref,
        confidence: conf,
      })),
      confidence: conf,
    }),
  };
}
