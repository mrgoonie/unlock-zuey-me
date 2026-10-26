/**
 * One path for every model call: OpenRouter models in order (only while the learner and global daily USD
 * budgets allow), then Workers AI (capped per learner per day). Every successful call records usage.
 * `parse` validates the raw text; a rejected output moves on to the next model just like an HTTP error.
 */
import { recordEventSafe } from '../observer/events';
import { utcDay } from '../learning/learner-day';
import {
  openRouterChat, workersAiChat, type AiCompletion, type ChatMessage, type JsonSchemaSpec,
} from './ai-clients';
import { estimateCostUsd } from './ai-models';
import { budgetLimits, readUsage, recordUsage } from './ai-usage';

export interface AiDeps {
  env: Env;
  now?: () => Date;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type AiPurpose = 'grade' | 'hint' | 'chat';

export interface AiRequest<T> {
  purpose: AiPurpose;
  learnerId: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  openRouterModels: readonly string[];
  workersAiModel: string;
  jsonSchema?: JsonSchemaSpec;
  parse: (text: string) => T;
  timeoutMs: number;
  runId?: string;
  missionId?: string;
}

export interface AiResult<T> {
  value: T;
  model: string;
  provider: 'openrouter' | 'workers-ai';
}

/** Every AI path failed or is over budget. `reason` lets callers choose a static fallback or a 429/503. */
export class AiUnavailableError extends Error {
  constructor(public reason: 'budget' | 'failed') {
    super(`ai unavailable: ${reason}`);
  }
}

export async function runAi<T>(deps: AiDeps, req: AiRequest<T>): Promise<AiResult<T>> {
  const { env } = deps;
  const now = deps.now?.() ?? new Date();
  const day = utcDay(now);
  const limits = budgetLimits(env);
  const event = (name: 'ai.budget_exceeded' | 'ai.fallback_used', props: Record<string, string>) =>
    recordEventSafe(env.DB, { learnerId: req.learnerId, name, runId: req.runId, missionId: req.missionId, props: { purpose: req.purpose, ...props } });

  let usage;
  try {
    usage = await readUsage(env.DB, day, req.learnerId);
  } catch (err) {
    // Without usage numbers we cannot prove we are under budget: skip paid models, still try the fallback.
    console.error('ai usage read failed', err);
    usage = null;
  }

  const record = async (c: AiCompletion, workersAi: boolean) => {
    try {
      await recordUsage(env.DB, day, req.learnerId, {
        inputTokens: c.inputTokens, outputTokens: c.outputTokens, costUsd: estimateCostUsd(c.model, c.inputTokens, c.outputTokens), workersAi,
      });
    } catch (err) {
      console.error('ai usage record failed', err);
    }
  };

  let fallbackReason = 'no_key';
  if (env.OPENROUTER_API_KEY && usage) {
    const overGlobal = usage.global.costUsd >= limits.globalUsd;
    const overLearner = usage.learner.costUsd >= limits.perLearnerUsd;
    if (overGlobal || overLearner) {
      fallbackReason = 'budget';
      await event('ai.budget_exceeded', { scope: overGlobal ? 'global' : 'learner' });
    } else {
      fallbackReason = 'openrouter_failed';
      for (const model of req.openRouterModels) {
        try {
          const c = await openRouterChat({
            apiKey: env.OPENROUTER_API_KEY, siteUrl: env.PUBLIC_SITE_URL || 'https://unlock.zuey.me', model,
            messages: req.messages, maxTokens: req.maxTokens, temperature: req.temperature,
            jsonSchema: req.jsonSchema, timeoutMs: req.timeoutMs, fetchImpl: deps.fetchImpl,
          });
          await record(c, false);
          return { value: req.parse(c.content), model: c.model, provider: 'openrouter' };
        } catch (err) {
          console.warn('openrouter attempt failed', req.purpose, model, err instanceof Error ? err.message : err);
        }
      }
    }
  } else if (env.OPENROUTER_API_KEY && !usage) {
    fallbackReason = 'usage_unknown';
  }

  if (usage && usage.learner.workersAiRequests >= limits.workersAiPerLearner) {
    await event('ai.budget_exceeded', { scope: 'workers_ai' });
    throw new AiUnavailableError('budget');
  }
  await event('ai.fallback_used', { reason: fallbackReason, model: req.workersAiModel });
  try {
    const messages = req.jsonSchema ? withJsonInstruction(req.messages, req.jsonSchema) : req.messages;
    const c = await workersAiChat(env.AI, req.workersAiModel, messages, req.maxTokens);
    await record(c, true);
    return { value: req.parse(c.content), model: c.model, provider: 'workers-ai' };
  } catch (err) {
    console.error('workers ai failed', req.purpose, err instanceof Error ? err.message : err);
    throw new AiUnavailableError('failed');
  }
}

/** Workers AI gets the schema as an instruction (no strict response_format); output is still zod-validated. */
function withJsonInstruction(messages: ChatMessage[], spec: JsonSchemaSpec): ChatMessage[] {
  const instruction = `Reply with ONLY one JSON object (no markdown, no prose) that matches this JSON Schema:\n${JSON.stringify(spec.schema)}`;
  return [...messages, { role: 'system', content: instruction }];
}
