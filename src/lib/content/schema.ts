/**
 * Content-as-data schema for missions, concepts and badges.
 *
 * Every YAML file under content// is parsed with these schemas at build time (loader.ts) and in CI
 * (scripts/validate-content.ts). Cross-references (concept ids, competency ids, step ids used by rubric
 * checks) are verified by `validateContentGraph` so a broken mission can never be published.
 */
import { z } from 'zod';

export const COMPETENCIES = ['discover', 'describe', 'delegate', 'verify', 'operate', 'reflect'] as const;
export type CompetencyId = (typeof COMPETENCIES)[number];

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'kebab-case id');
const text = z.string().trim().min(1);
/** Answer field ids (snake_case or kebab-case): the keys under answers[stepId]. */
const fieldId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'field id');

/** Four-step hint ladder: nudge to think → next step → similar example → direct explanation. */
const hintLadder = z.tuple([text, text, text, text]);

const stepBase = {
  id,
  title: text,
  /** Static hints shown when the AI coach is unavailable; the coach also uses them as grounding. */
  hints: hintLadder,
};

const field = z.object({
  id: fieldId,
  label: text,
  placeholder: z.string().optional(),
  kind: z.enum(['text', 'textarea', 'list']),
  required: z.boolean().default(true),
  /** Minimum characters (text/textarea) or items (list) for the field to count as filled. */
  min: z.number().int().min(0).default(1),
});

const option = z.object({ id, text: text });

export const verificationVerdicts = ['verified', 'needs_lookup', 'insufficient', 'expert'] as const;

export const stepSchema = z.discriminatedUnion('type', [
  z.object({ ...stepBase, type: z.literal('intro'), body: text }),
  z.object({ ...stepBase, type: z.literal('guided-input'), prompt: text, fields: z.array(field).min(1) }),
  z.object({
    ...stepBase,
    type: z.literal('ai-task'),
    instruction: text,
    /** Example prompts the learner may copy into ChatGPT/Claude or the in-app practice chat. */
    prompt_suggestions: z.array(text).min(1),
    allow_in_app_chat: z.boolean().default(true),
    /** Where the learner pastes what the AI answered (text) and optionally a screenshot. */
    capture: z.object({ id: fieldId, label: text, min: z.number().int().min(0).default(20), allow_image: z.boolean().default(true) }),
  }),
  z.object({
    ...stepBase,
    type: z.literal('verification'),
    instruction: text,
    claims: z.array(z.object({
      id,
      text: text,
      answer: z.enum(verificationVerdicts),
      explanation: text,
    })).min(2),
    /** Free-text notes on how the learner checked (counted by rubric checks). */
    notes: z.object({ id: fieldId, label: text, min: z.number().int().min(0).default(20) }),
  }),
  z.object({
    ...stepBase,
    type: z.literal('quiz'),
    questions: z.array(z.object({
      id,
      prompt: text,
      options: z.array(option).min(2),
      correct: z.array(id).min(1),
      explanation: text,
    })).min(1),
  }),
  z.object({
    ...stepBase,
    type: z.literal('prediction'),
    /** Learner predicts and states confidence before seeing the answer (calibration practice). */
    question: text,
    options: z.array(option).min(2),
    correct: id,
    explanation: text,
  }),
  z.object({ ...stepBase, type: z.literal('reflection'), prompt: text, field_id: fieldId, min: z.number().int().min(0).default(30) }),
]);
export type MissionStep = z.infer<typeof stepSchema>;

/** Deterministic rubric checks: graded by code, never by a model. Each returns a score in [0, 1]. */
export const checkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fields_filled'), step: id, fields: z.array(fieldId).min(1) }),
  z.object({ kind: z.literal('list_min'), step: id, field: fieldId, min: z.number().int().min(1) }),
  z.object({ kind: z.literal('text_min'), step: id, field: fieldId, min_chars: z.number().int().min(1) }),
  z.object({ kind: z.literal('contains_any'), step: id, field: fieldId, terms: z.array(text).min(1) }),
  z.object({ kind: z.literal('quiz_score'), step: id }),
  z.object({ kind: z.literal('claims_score'), step: id }),
  z.object({ kind: z.literal('prediction_correct'), step: id }),
]);
export type RubricCheck = z.infer<typeof checkSchema>;

export const criterionSchema = z.object({
  id,
  label: text,
  weight: z.number().positive(),
  competency: z.enum(COMPETENCIES),
  method: z.enum(['deterministic', 'ai']),
  /** Required when method = deterministic. */
  check: checkSchema.optional(),
  /** For method = ai: what a strong answer shows. The grader treats learner text as data only. */
  guidance: z.string().optional(),
  /** Steps whose answers the AI grader may read for this criterion. */
  step_refs: z.array(id).default([]),
}).superRefine((c, ctx) => {
  if (c.method === 'deterministic' && !c.check) ctx.addIssue({ code: 'custom', message: `criterion ${c.id}: deterministic needs check` });
  if (c.method === 'ai' && (!c.guidance || c.step_refs.length === 0)) {
    ctx.addIssue({ code: 'custom', message: `criterion ${c.id}: ai needs guidance and step_refs` });
  }
});
export type RubricCriterion = z.infer<typeof criterionSchema>;

export const missionSchema = z.object({
  schema_version: z.literal(1),
  id,
  version: z.number().int().min(1),
  locale: z.enum(['vi', 'en']),
  status: z.enum(['draft', 'published']),
  title: text,
  tagline: text,
  emoji: text,
  /** What the learner can do afterwards, in plain words. */
  outcome: text,
  why_it_matters: text,
  persona_tags: z.array(z.enum(['beginner', 'basic', 'advanced', 'everyday-life', 'work'])).min(1),
  estimated_minutes: z.number().int().min(3).max(90),
  risk_tier: z.enum(['low', 'medium', 'high']),
  safety_notes: z.array(text).default([]),
  competency_targets: z.array(z.object({ id: z.enum(COMPETENCIES), weight: z.number().positive() })).min(1),
  concept_refs: z.array(id).default([]),
  /** A sibling mission with different data, used to prove transfer. */
  transfer_variant: id.optional(),
  steps: z.array(stepSchema).min(2),
  rubric: z.object({
    pass_score: z.number().min(0).max(1),
    criteria: z.array(criterionSchema).min(2),
  }),
});
export type Mission = z.infer<typeof missionSchema>;

export const conceptSchema = z.object({
  id,
  label_vi: text,
  label_en: text,
  emoji: text,
  layer: z.enum(['foundation', 'just-in-time', 'current-fact']),
  group: z.enum(['fundamentals', 'prompt-knowledge', 'agents-integration', 'software', 'advanced']),
  one_liner: text,
  beginner_explanation: text,
  analogy: text,
  rigorous_explanation: text,
  misconceptions: z.array(text).default([]),
  examples: z.array(text).min(1),
  when_you_need_it: text,
  when_you_dont: z.string().optional(),
  related: z.array(id).default([]),
  prerequisites: z.array(id).default([]),
  lab: z.enum(['token-predictor', 'context-lab', 'hallucination-detective']).optional(),
  source_refs: z.array(z.object({ title: text, url: z.url() })).default([]),
  last_reviewed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Required for current-fact concepts: shows a "cần kiểm tra lại" badge after this date. */
  review_due_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  confidence: z.enum(['high', 'medium', 'low']),
}).superRefine((c, ctx) => {
  if (c.layer === 'current-fact' && !c.review_due_at) ctx.addIssue({ code: 'custom', message: `concept ${c.id}: current-fact needs review_due_at` });
});
export type Concept = z.infer<typeof conceptSchema>;

export interface ContentGraph {
  missions: Mission[];
  concepts: Concept[];
}

/** Cross-reference checks that zod cannot express per file. Returns human-readable errors. */
export function validateContentGraph(graph: ContentGraph): string[] {
  const errors: string[] = [];
  const conceptIds = new Set(graph.concepts.map((c) => c.id));
  const missionIds = new Set(graph.missions.map((m) => m.id));
  const dup = (ids: string[], kind: string) => {
    const seen = new Set<string>();
    for (const i of ids) {
      if (seen.has(i)) errors.push(`duplicate ${kind} id: ${i}`);
      seen.add(i);
    }
  };
  dup(graph.missions.map((m) => m.id), 'mission');
  dup(graph.concepts.map((c) => c.id), 'concept');

  for (const c of graph.concepts) {
    for (const r of [...c.related, ...c.prerequisites]) if (!conceptIds.has(r)) errors.push(`concept ${c.id}: unknown concept ref ${r}`);
  }
  for (const m of graph.missions) {
    const where = `mission ${m.id}`;
    for (const r of m.concept_refs) if (!conceptIds.has(r)) errors.push(`${where}: unknown concept ref ${r}`);
    if (m.transfer_variant && !missionIds.has(m.transfer_variant)) errors.push(`${where}: unknown transfer_variant ${m.transfer_variant}`);
    dup(m.steps.map((s) => s.id), `${where} step`);
    dup(m.rubric.criteria.map((c) => c.id), `${where} criterion`);
    const steps = new Map(m.steps.map((s) => [s.id, s]));
    for (const c of m.rubric.criteria) {
      for (const ref of c.step_refs) if (!steps.has(ref)) errors.push(`${where}: criterion ${c.id} refs unknown step ${ref}`);
      if (!c.check) continue;
      const step = steps.get(c.check.step);
      if (!step) {
        errors.push(`${where}: criterion ${c.id} checks unknown step ${c.check.step}`);
        continue;
      }
      const kindNeeds: Record<string, string> = {
        quiz_score: 'quiz', claims_score: 'verification', prediction_correct: 'prediction',
      };
      const need = kindNeeds[c.check.kind];
      if (need && step.type !== need) errors.push(`${where}: criterion ${c.id} ${c.check.kind} needs a ${need} step`);
      const fieldIds = stepFieldIds(step);
      const fields = 'fields' in c.check ? c.check.fields : 'field' in c.check ? [c.check.field] : [];
      for (const f of fields) if (!fieldIds.includes(f)) errors.push(`${where}: criterion ${c.id} refs unknown field ${f} in step ${step.id}`);
    }
    const total = m.rubric.criteria.reduce((s, c) => s + c.weight, 0);
    if (total <= 0) errors.push(`${where}: rubric weights sum to 0`);
  }
  return errors;
}

/** Field ids a step stores answers under (what rubric checks and the AI grader can reference). */
export function stepFieldIds(step: MissionStep): string[] {
  switch (step.type) {
    case 'guided-input': return step.fields.map((f) => f.id);
    case 'ai-task': return [step.capture.id];
    case 'verification': return [step.notes.id, ...step.claims.map((c) => c.id)];
    case 'quiz': return step.questions.map((q) => q.id);
    case 'prediction': return ['choice', 'confidence'];
    case 'reflection': return [step.field_id];
    case 'intro': return [];
  }
}
