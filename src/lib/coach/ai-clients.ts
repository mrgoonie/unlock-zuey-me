/**
 * Thin clients for OpenRouter (chat completions, optional strict JSON schema) and Workers AI.
 * Both return the raw text plus token usage; callers validate the content.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletion {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export class AiCallError extends Error {}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function openRouterChat(opts: {
  apiKey: string;
  siteUrl: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  jsonSchema?: JsonSchemaSpec;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<AiCompletion> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };
  if (opts.jsonSchema) {
    body.response_format = { type: 'json_schema', json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema } };
    // Only route to providers that actually honour response_format.
    body.provider = { require_parameters: true };
  }
  const res = await (opts.fetchImpl ?? fetch)(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': opts.siteUrl,
      'X-Title': 'AI Unlocked',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new AiCallError(`openrouter ${opts.model} http ${res.status}`);
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    model?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  if (!data || data.error) throw new AiCallError(`openrouter ${opts.model} error ${data?.error?.message ?? 'bad body'}`);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new AiCallError(`openrouter ${opts.model} empty content`);
  return {
    content,
    model: typeof data.model === 'string' && data.model ? data.model : opts.model,
    inputTokens: num(data.usage?.prompt_tokens),
    outputTokens: num(data.usage?.completion_tokens),
  };
}

/** Minimal view of the AI binding: the generated model union may not list every catalog model yet. */
type AiRunner = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

/**
 * Rejects with AiCallError when `work` has not settled within `timeoutMs`. The underlying call is not
 * cancelled (the AI binding takes no AbortSignal), but the caller stops waiting and moves on.
 */
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiCallError(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function workersAiChat(
  ai: Ai, model: string, messages: ChatMessage[], maxTokens: number, timeoutMs: number,
): Promise<AiCompletion> {
  // Cast justified: the binding accepts any catalog model id at runtime; types lag behind the catalog.
  const call = (ai as unknown as AiRunner).run(model, { messages, max_tokens: maxTokens });
  const out = (await withTimeout(call, timeoutMs, `workers-ai ${model}`)) as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  const raw = out?.response ?? out?.choices?.[0]?.message?.content;
  const content = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : '';
  if (content.trim() === '') throw new AiCallError(`workers-ai ${model} empty response`);
  return { content, model, inputTokens: num(out?.usage?.prompt_tokens), outputTokens: num(out?.usage?.completion_tokens) };
}

/** Extracts the JSON object from model text (tolerates ```json fences or prose around it). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiCallError('no JSON object in model output');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AiCallError('model output is not valid JSON');
  }
}
