/**
 * AI rubric grader: Sonnet → DeepSeek on OpenRouter (strict JSON schema), then Workers AI (JSON parsed and
 * zod-validated). Throws AiUnavailableError when every path failed; the caller keeps the submission.
 */
import type { Mission, RubricCriterion } from '../content/schema';
import type { Answers } from '../learning/types';
import { runAi, type AiDeps } from './ai-gateway';
import { GRADER_MODELS, WORKERS_AI_MODEL } from './ai-models';
import { buildGraderMessages, graderJsonSchema, parseGraderOutput, type GraderOutput } from './grader-prompt';
import { newBoundary } from './untrusted-text';

export interface AiGrade extends GraderOutput {
  model: string;
}

export async function gradeWithAi(deps: AiDeps, input: {
  learnerId: string;
  runId: string;
  mission: Mission;
  criteria: RubricCriterion[];
  answers: Answers;
  imageCount: number;
}): Promise<AiGrade> {
  const ids = input.criteria.map((c) => c.id);
  const boundary = newBoundary();
  const result = await runAi(deps, {
    purpose: 'grade',
    learnerId: input.learnerId,
    runId: input.runId,
    missionId: input.mission.id,
    messages: buildGraderMessages({ mission: input.mission, criteria: input.criteria, answers: input.answers, imageCount: input.imageCount, boundary }),
    maxTokens: 1800,
    temperature: 0.2,
    openRouterModels: GRADER_MODELS,
    workersAiModel: WORKERS_AI_MODEL,
    jsonSchema: graderJsonSchema(ids),
    parse: (text) => parseGraderOutput(text, ids),
    timeoutMs: 45_000,
  });
  return { ...result.value, model: result.model };
}
