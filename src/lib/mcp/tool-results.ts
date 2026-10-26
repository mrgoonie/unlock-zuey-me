/**
 * Shared shapes for MCP tool results: success = structuredContent + the same JSON as text; failures are
 * tool errors (isError) the model can act on. LearningError codes map 1:1; unknown errors are hidden.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { LearnerContext } from '../learning/types';
import { LearningError } from '../learning/types';
import { canRead, canWrite, LEARN_WRITE } from './mcp-scopes';

/** What every tool closes over: the token's learner (never taken from tool arguments) and its scopes. */
export interface McpToolContext {
  env: Env;
  learner: LearnerContext;
  scopes: readonly string[];
}

export function toolOk(structured: Record<string, unknown>, summary?: string): CallToolResult {
  const json = JSON.stringify(structured);
  return {
    content: [{ type: 'text', text: summary ? `${summary}\n\n${json}` : json }],
    structuredContent: structured,
  };
}

export type ToolErrorCode = LearningError['code'] | 'insufficient_scope' | 'internal';

export function toolError(code: ToolErrorCode, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error (${code}): ${message}` }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

const NEXT_STEP: Partial<Record<LearningError['code'], string>> = {
  not_found: 'Check the id with list_missions or get_profile (activeRuns).',
  conflict: 'Call get_run to see the current state, then retry.',
  budget_exceeded: 'The daily AI budget is used up; try again tomorrow.',
  unavailable: 'Temporary problem; retry in a moment.',
};

/** Maps a thrown error to a tool error without leaking internals. */
export function errorToToolResult(err: unknown, tool: string): CallToolResult {
  if (err instanceof LearningError) {
    const hint = NEXT_STEP[err.code];
    return toolError(err.code, hint ? `${err.message} ${hint}` : err.message);
  }
  console.error(`mcp tool ${tool} failed`, err instanceof Error ? `${err.name}: ${err.message}` : 'error');
  return toolError('internal', 'Unexpected server error. The learner\'s saved work is unaffected; retry once.');
}

/** Scope gate inside the handler (defence in depth behind the HTTP-level scope challenge). */
export function scopeError(ctx: McpToolContext, need: 'read' | 'write'): CallToolResult | null {
  const ok = need === 'write' ? canWrite(ctx.scopes) : canRead(ctx.scopes);
  if (ok) return null;
  return toolError('insufficient_scope', need === 'write'
    ? `This action needs the ${LEARN_WRITE} scope. Ask the user to reconnect AI Unlocked and allow it.`
    : 'This token has no AI Unlocked learning scope.');
}

/** Runs a tool body with the scope gate and error mapping. */
export async function runTool(
  ctx: McpToolContext, tool: string, need: 'read' | 'write', body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const denied = scopeError(ctx, need);
  if (denied) return denied;
  try {
    return await body();
  } catch (err) {
    return errorToToolResult(err, tool);
  }
}
