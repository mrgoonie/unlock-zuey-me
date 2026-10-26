/**
 * Mission content as the learner's browser may see it before grading. Mirrors what the MCP view
 * (src/lib/mcp/mission-public-view.ts) strips: claim verdicts + explanations, quiz/prediction correct
 * answers + explanations, the static hint ladder (hints are served one level at a time by the API) and
 * rubric checks/guidance. Keys reach the browser only through `answerKeyForRun` (answer-reveals.ts).
 *
 * The shape stays close to the content schema (snake_case) so the runner UI reads it like a Mission.
 * Every object is built field by field: nothing new in the schema can leak through a spread.
 * This module must stay free of server-only imports: the runner island imports its types.
 */
import type { CompetencyId, Mission, MissionStep } from '../content/schema';

type Step<T extends MissionStep['type']> = Extract<MissionStep, { type: T }>;
type Option = { id: string; text: string };

interface StepBase { id: string; title: string }

export type LearnerStep =
  | (StepBase & { type: 'intro'; body: string })
  | (StepBase & { type: 'guided-input'; prompt: string; fields: Step<'guided-input'>['fields'] })
  | (StepBase & {
    type: 'ai-task'; instruction: string; prompt_suggestions: string[]; allow_in_app_chat: boolean;
    capture: Step<'ai-task'>['capture'];
  })
  | (StepBase & {
    type: 'verification'; instruction: string; claims: Array<{ id: string; text: string }>;
    notes: Step<'verification'>['notes'];
  })
  /** `multi`: the question has several correct options (checkboxes instead of radios). */
  | (StepBase & { type: 'quiz'; questions: Array<{ id: string; prompt: string; options: Option[]; multi: boolean }> })
  | (StepBase & { type: 'prediction'; question: string; options: Option[] })
  | (StepBase & { type: 'reflection'; prompt: string; field_id: string; min: number });

export type LearnerStepOf<T extends LearnerStep['type']> = Extract<LearnerStep, { type: T }>;

export interface LearnerCriterion {
  id: string;
  label: string;
  weight: number;
  competency: CompetencyId;
  method: 'deterministic' | 'ai';
  /** The step a learner should revisit when this criterion scores low (null when it has none). */
  step: string | null;
}

export interface LearnerMission {
  id: string;
  version: number;
  title: string;
  tagline: string;
  emoji: string;
  outcome: string;
  why_it_matters: string;
  estimated_minutes: number;
  risk_tier: Mission['risk_tier'];
  safety_notes: string[];
  transfer_variant: string | null;
  steps: LearnerStep[];
  rubric: { pass_score: number; criteria: LearnerCriterion[] };
}

const options = (os: Option[]): Option[] => os.map((o) => ({ id: o.id, text: o.text }));

export function learnerStep(step: MissionStep): LearnerStep {
  const base = { id: step.id, title: step.title };
  switch (step.type) {
    case 'intro':
      return { ...base, type: 'intro', body: step.body };
    case 'guided-input':
      return {
        ...base, type: 'guided-input', prompt: step.prompt,
        fields: step.fields.map((f) => ({ id: f.id, label: f.label, placeholder: f.placeholder, kind: f.kind, required: f.required, min: f.min })),
      };
    case 'ai-task':
      return {
        ...base, type: 'ai-task', instruction: step.instruction, prompt_suggestions: [...step.prompt_suggestions],
        allow_in_app_chat: step.allow_in_app_chat,
        capture: { id: step.capture.id, label: step.capture.label, min: step.capture.min, allow_image: step.capture.allow_image },
      };
    case 'verification':
      return {
        ...base, type: 'verification', instruction: step.instruction,
        claims: step.claims.map((c) => ({ id: c.id, text: c.text })),
        notes: { id: step.notes.id, label: step.notes.label, min: step.notes.min },
      };
    case 'quiz':
      return {
        ...base, type: 'quiz',
        questions: step.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: options(q.options), multi: q.correct.length > 1 })),
      };
    case 'prediction':
      return { ...base, type: 'prediction', question: step.question, options: options(step.options) };
    case 'reflection':
      return { ...base, type: 'reflection', prompt: step.prompt, field_id: step.field_id, min: step.min };
  }
}

export function learnerMissionView(m: Mission): LearnerMission {
  return {
    id: m.id,
    version: m.version,
    title: m.title,
    tagline: m.tagline,
    emoji: m.emoji,
    outcome: m.outcome,
    why_it_matters: m.why_it_matters,
    estimated_minutes: m.estimated_minutes,
    risk_tier: m.risk_tier,
    safety_notes: [...m.safety_notes],
    transfer_variant: m.transfer_variant ?? null,
    steps: m.steps.map(learnerStep),
    rubric: {
      pass_score: m.rubric.pass_score,
      criteria: m.rubric.criteria.map((c) => ({
        id: c.id, label: c.label, weight: c.weight, competency: c.competency, method: c.method,
        step: c.check?.step ?? c.step_refs[c.step_refs.length - 1] ?? null,
      })),
    },
  };
}
