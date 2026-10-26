/**
 * One path for every model call: OpenRouter models in order (only while the learner and global daily USD
 * budgets allow), then Workers AI (capped per learner and globally per day). Budgets are reserved before
 * each call and settled after it (see ai-usage.ts), so concurrent requests cannot overshoot them.
 * Practice chat and hints draw from a capped share of the global caps so they can never starve grading.
 * `parse` validates the raw text; a rejected output moves on to the next model just like an HTTP error.
 */
import { recordEventSafe } from '../observer/events';
import { utcDay } from '../learning/learner-day';
import {
  openRouterChat, workersAiChat, type AiCompletion, type ChatMessage, type JsonSchemaSpec,
} from './ai-clients';
import { estimateCostUsd, WORKERS_AI_TIMEOUT_MS } from './ai-models';
import {
  budgetLimits, readUsage, releaseUsd, reserveUsd, reserveWorkersAiCall, settleUsage, type BudgetPool, type UsageTotals,
} from './ai-usage';

export interface AiDeps {
  env: Env;
  now?: () => Date;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type AiPurpose = 'grade' | 'hint' | 'chat';

/** Grading may use the full global caps; practice chat and hints share the capped coaching slice. */
export const budgetPool = (purpose: AiPurpose): BudgetPool => (purpose === 'grade' ? 'grading' : 'coaching');

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
  const db = env.DB;
  const pool = budgetPool(req.purpose);
  const event = (name: 'ai.budget_exceeded' | 'ai.fallback_used', props: Record<string, string>) =>
    recordEventSafe(db, { learnerId: req.learnerId, name, runId: req.runId, missionId: req.missionId, props: { purpose: req.purpose, ...props } });
  /** Which cap stopped a reservation, for the budget event (read only on the refusal path). */
  const exceededScope = async (
    overGlobal: (u: UsageTotals) => boolean, overCoachShare: (u: UsageTotals) => boolean,
  ): Promise<'global' | 'coach_share' | 'learner'> => {
    try {
      const { global } = await readUsage(db, day, req.learnerId);
      if (overGlobal(global)) return 'global';
      return pool === 'coaching' && overCoachShare(global) ? 'coach_share' : 'learner';
    } catch {
      return 'learner';
    }
  };
  const settle = async (c: AiCompletion, reservedUsd: number) => {
    try {
      await settleUsage(db, day, req.learnerId, pool, {
        inputTokens: c.inputTokens, outputTokens: c.outputTokens, costUsd: estimateCostUsd(c.model, c.inputTokens, c.outputTokens), reservedUsd,
      });
    } catch (err) {
      console.error('ai usage record failed', err);
    }
  };
  const inputTokens = estimateInputTokens(req.messages);

  let fallbackReason = 'no_key';
  if (env.OPENROUTER_API_KEY) {
    fallbackReason = 'openrouter_failed';
    for (const model of req.openRouterModels) {
      // Reserve the worst case (estimated prompt + every allowed output token) before calling.
      const reserved = estimateCostUsd(model, inputTokens, req.maxTokens);
      let ok: boolean;
      try {
        ok = await reserveUsd(db, day, req.learnerId, reserved, limits, pool);
      } catch (err) {
        // Without usage numbers we cannot prove we are under budget: skip paid models, still try the fallback.
        console.error('ai usage reservation failed', err);
        fallbackReason = 'usage_unknown';
        break;
      }
      if (!ok) {
        fallbackReason = 'budget';
        await event('ai.budget_exceeded', {
          scope: await exceededScope(
            (g) => g.costUsd + g.reservedUsd + reserved > limits.globalUsd,
            (g) => g.coachCostUsd + g.coachReservedUsd + reserved > limits.coachGlobalUsd,
          ),
        });
        break;
      }
      let c: AiCompletion;
      try {
        c = await openRouterChat({
          apiKey: env.OPENROUTER_API_KEY, siteUrl: env.PUBLIC_SITE_URL || 'https://unlock.zuey.me', model,
          messages: req.messages, maxTokens: req.maxTokens, temperature: req.temperature,
          jsonSchema: req.jsonSchema, timeoutMs: req.timeoutMs, fetchImpl: deps.fetchImpl,
        });
      } catch (err) {
        console.warn('openrouter attempt failed', req.purpose, model, err instanceof Error ? err.message : err);
        await releaseUsd(db, day, req.learnerId, reserved, pool).catch((e) => console.error('ai usage release failed', e));
        continue;
      }
      // A completed call is paid for even when its output is then rejected.
      await settle(c, reserved);
      try {
        return { value: req.parse(c.content), model: c.model, provider: 'openrouter' };
      } catch (err) {
        console.warn('openrouter output rejected', req.purpose, model, err instanceof Error ? err.message : err);
      }
    }
  }

  let allowed = true;
  try {
    allowed = await reserveWorkersAiCall(db, day, req.learnerId, limits, pool);
  } catch (err) {
    // Same stance as before reservations existed: a usage-store outage must not block the fallback.
    console.error('workers ai reservation failed', err);
  }
  if (!allowed) {
    const scope = await exceededScope(
      (g) => g.workersAiRequests >= limits.workersAiGlobal,
      (g) => g.coachWorkersAiRequests >= limits.coachWorkersAiGlobal,
    );
    await event('ai.budget_exceeded', { scope: scope === 'learner' ? 'workers_ai' : `workers_ai_${scope}` });
    throw new AiUnavailableError('budget');
  }
  await event('ai.fallback_used', { reason: fallbackReason, model: req.workersAiModel });
  try {
    const messages = req.jsonSchema ? withJsonInstruction(req.messages, req.jsonSchema) : req.messages;
    const c = await workersAiChat(env.AI, req.workersAiModel, messages, req.maxTokens, WORKERS_AI_TIMEOUT_MS);
    await settle(c, 0);
    return { value: req.parse(c.content), model: c.model, provider: 'workers-ai' };
  } catch (err) {
    console.error('workers ai failed', req.purpose, err instanceof Error ? err.message : err);
    throw new AiUnavailableError('failed');
  }
}

/** Conservative prompt size: Vietnamese text runs at roughly 2–3 characters per token. */
function estimateInputTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 2) + 16 * messages.length;
}

/** Workers AI gets the schema as an instruction (no strict response_format); output is still zod-validated. */
function withJsonInstruction(messages: ChatMessage[], spec: JsonSchemaSpec): ChatMessage[] {
  const instruction = `Reply with ONLY one JSON object (no markdown, no prose) that matches this JSON Schema:\n${JSON.stringify(spec.schema)}`;
  return [...messages, { role: 'system', content: instruction }];
}
