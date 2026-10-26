/**
 * Pure pre-filters of the ai-tutor analyzer (a server-side background analyzer, not a Claude Code subagent).
 * They run on a claimed session window before any AI call, so trivial or repeated turns never cost a
 * model call:
 * - `trivial`: no prompt and a reply under 80 chars, or a prompt under 12 chars with no tool use;
 * - `duplicate`: the same content as an earlier event of the window;
 * - `no_value`: the stored payload is missing or not a turn (cannot be analysed).
 * `platformTouch` records whether the kept events interacted with unlock.zuey.me (its MCP tools, a mission
 * or a run); product observations are only allowed when it is true.
 */
import { z } from 'zod';
import { ingestTurnV1Schema } from './ingest-contract';
import type { InsightSkipReason } from './insight-types';

/** The `turn` part of an ingest payload, as analysed. */
export type QueuedTurn = z.infer<typeof ingestTurnV1Schema>['turn'];

export const TRIVIAL_REPLY_MAX_CHARS = 80;
export const TRIVIAL_PROMPT_MAX_CHARS = 12;

const turnSchema = ingestTurnV1Schema.shape.turn;

/**
 * Reads a stored payload. Ingest stores either the whole validated v1 body or only its `turn`; both are
 * accepted. Anything that does not validate as a turn returns null.
 */
export function parseQueuedTurn(payloadJson: string | null): QueuedTurn | null {
  if (!payloadJson) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const candidate = raw && typeof raw === 'object' && 'turn' in raw ? (raw as { turn: unknown }).turn : raw;
  const parsed = turnSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function isTrivialTurn(turn: QueuedTurn): boolean {
  const reply = turn.assistantFinal.trim();
  if (turn.userPrompt === null) return reply.length < TRIVIAL_REPLY_MAX_CHARS;
  return turn.userPrompt.trim().length < TRIVIAL_PROMPT_MAX_CHARS && turn.tools.length === 0;
}

/** Stable content key: whitespace-normalised prompt, reply and tool usage (platform ids excluded). */
export function turnContentKey(turn: QueuedTurn): string {
  const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const tools = [...turn.tools].map((t) => `${t.name}:${t.ok ? 1 : 0}:${t.count}`).sort().join(',');
  return JSON.stringify([norm(turn.userPrompt), norm(turn.assistantFinal), tools]);
}

export function touchesPlatform(turn: QueuedTurn): boolean {
  const p = turn.platform;
  return !!p && (p.mcpTools.length > 0 || !!p.missionId || !!p.runId);
}

export interface FilterInput {
  id: string;
  payloadJson: string | null;
}

export interface KeptEvent {
  id: string;
  turn: QueuedTurn;
}

export interface WindowFilterResult {
  kept: KeptEvent[];
  dropped: Array<{ id: string; reason: Extract<InsightSkipReason, 'trivial' | 'duplicate' | 'no_value'> }>;
  /** True when any kept event touched unlock.zuey.me (MCP tool, mission or run). */
  platformTouch: boolean;
}

/** Filters a window's events in order (callers pass them sorted by turn end). */
export function filterWindow(events: readonly FilterInput[]): WindowFilterResult {
  const kept: KeptEvent[] = [];
  const dropped: WindowFilterResult['dropped'] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const turn = parseQueuedTurn(e.payloadJson);
    if (!turn) {
      dropped.push({ id: e.id, reason: 'no_value' });
      continue;
    }
    if (isTrivialTurn(turn)) {
      dropped.push({ id: e.id, reason: 'trivial' });
      continue;
    }
    const key = turnContentKey(turn);
    if (seen.has(key)) {
      dropped.push({ id: e.id, reason: 'duplicate' });
      continue;
    }
    seen.add(key);
    kept.push({ id: e.id, turn });
  }
  return { kept, dropped, platformTouch: kept.some((k) => touchesPlatform(k.turn)) };
}
