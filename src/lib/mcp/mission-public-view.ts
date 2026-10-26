/**
 * Mission content as an MCP client may see it: everything the learner needs to do the work, nothing that
 * gives the rubric away. Removed: claim verdicts + explanations, quiz/prediction correct answers +
 * explanations, the static hint ladder (use get_hint) and rubric checks/guidance.
 */
import type { Mission, MissionStep } from '../content/schema';
import { stepFieldIds } from '../content/schema';

type PublicStep = Record<string, unknown> & { id: string; type: MissionStep['type']; title: string; answerFields: string[] };

function publicStep(step: MissionStep): PublicStep {
  const base = { id: step.id, type: step.type, title: step.title, answerFields: stepFieldIds(step) };
  switch (step.type) {
    case 'intro':
      return { ...base, body: step.body };
    case 'guided-input':
      return { ...base, prompt: step.prompt, fields: step.fields };
    case 'ai-task':
      return {
        ...base, instruction: step.instruction, promptSuggestions: step.prompt_suggestions,
        capture: { id: step.capture.id, label: step.capture.label, minChars: step.capture.min },
      };
    case 'verification':
      return {
        ...base, instruction: step.instruction,
        claims: step.claims.map((c) => ({ id: c.id, text: c.text })),
        verdictOptions: ['verified', 'needs_lookup', 'insufficient', 'expert'],
        notes: { id: step.notes.id, label: step.notes.label, minChars: step.notes.min },
      };
    case 'quiz':
      return { ...base, questions: step.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options })) };
    case 'prediction':
      return { ...base, question: step.question, options: step.options, answerFormat: { choice: 'option id', confidence: '0..100' } };
    case 'reflection':
      return { ...base, prompt: step.prompt, fieldId: step.field_id, minChars: step.min };
  }
}

export function missionPublicView(m: Mission): Record<string, unknown> {
  return {
    id: m.id,
    version: m.version,
    title: m.title,
    tagline: m.tagline,
    emoji: m.emoji,
    outcome: m.outcome,
    whyItMatters: m.why_it_matters,
    estimatedMinutes: m.estimated_minutes,
    riskTier: m.risk_tier,
    safetyNotes: m.safety_notes,
    competencies: m.competency_targets.map((c) => c.id),
    steps: m.steps.map(publicStep),
    rubric: {
      passScore: m.rubric.pass_score,
      criteria: m.rubric.criteria.map((c) => ({ id: c.id, label: c.label, weight: c.weight, competency: c.competency })),
    },
  };
}
