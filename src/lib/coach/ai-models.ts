/**
 * Model choices and the price table used to estimate spend for the daily budgets. Prices are USD per
 * million tokens (input / output) from OpenRouter /api/v1/models and the Workers AI pricing page
 * (2026-10-26). Unknown models are priced conservatively high so a typo can never make AI look free.
 */
export const GRADER_MODELS = ['anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4-pro'] as const;
export const COACH_MODELS = ['google/gemini-3.1-flash-lite'] as const;
/** Workers AI fallback for both grader and coach (SEA-tuned, handles Vietnamese). */
export const WORKERS_AI_MODEL = '@cf/aisingapore/gemma-sea-lion-v4-27b-it';

const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'anthropic/claude-sonnet-5.5': { input: 2.0, output: 10.0 },
  'deepseek/deepseek-v4-pro': { input: 0.955, output: 1.911 },
  'google/gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  '@cf/aisingapore/gemma-sea-lion-v4-27b-it': { input: 0.351, output: 0.555 },
};
const UNKNOWN_MODEL_PRICE = { input: 10.0, output: 30.0 };

/** Workers AI calls allowed per learner per UTC day once OpenRouter is unavailable or over budget. */
export const WORKERS_AI_DAILY_REQUESTS_PER_LEARNER = 60;
/** Defaults when the wrangler vars are missing or malformed. */
export const DEFAULT_BUDGET_USD_PER_LEARNER = 0.3;
export const DEFAULT_BUDGET_USD_GLOBAL = 5;

/** OpenRouter may answer with a dated variant (e.g. "...-20261001"); price it like its base slug. */
function priceFor(model: string): { input: number; output: number } {
  if (PRICES_PER_MTOK[model]) return PRICES_PER_MTOK[model];
  const base = Object.keys(PRICES_PER_MTOK).find((k) => model.startsWith(k));
  return base ? PRICES_PER_MTOK[base] : UNKNOWN_MODEL_PRICE;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  const cost = (Math.max(0, inputTokens) * p.input + Math.max(0, outputTokens) * p.output) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}
