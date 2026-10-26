// Builds the ingest payload v1 (docs/insights-ingest-contract.md, `ingestTurnV1Schema` in
// src/lib/insights/ingest-contract.ts). The payload is strict: only the documented fields, never `cwd`,
// `permission_mode`, file contents, tool arguments or tool results. Every text field is redacted before it
// is truncated, so a cut can never expose part of a secret.
import crypto from 'node:crypto';
import {
  ADAPTER, ASSISTANT_FINAL_MAX_CHARS, CLIENT_TARGET_BYTES, REDACTION_KINDS_MAX, SKILL_VERSION, USER_PROMPT_MAX_CHARS,
} from './constants.mjs';
import { redactText } from './redact.mjs';

/** @param {string} s */
export const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Dedupe key of one turn: sha256(session_id + ':' + (prompt_id ?? sha256(last_assistant_message))).
 * A `stop_hook_active` re-fire of the same prompt keeps the same key, so the server replaces the pending payload.
 * @param {{ session_id: string, prompt_id?: unknown, last_assistant_message?: unknown }} input
 */
export function idempotencyKeyFor(input) {
  const promptId = typeof input.prompt_id === 'string' && input.prompt_id !== '' ? input.prompt_id : null;
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  return sha256Hex(`${input.session_id}:${promptId ?? sha256Hex(last)}`);
}

/** Cuts `text` to `max` UTF-16 units without splitting a surrogate pair. */
function cut(text, max) {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

const byteLength = (s) => Buffer.byteLength(s, 'utf8');

/**
 * @typedef {import('./transcript-window.mjs').TranscriptWindow} TranscriptWindow
 * @typedef {{ session_id: string, prompt_id?: unknown, last_assistant_message?: unknown, stop_hook_active?: unknown }} StopInput
 */

/**
 * @param {{ input: StopInput, window: TranscriptWindow, installSalt: string, now: Date }} args
 * @returns {Record<string, any>} a payload that satisfies ingestTurnV1Schema (sentAt is refreshed at upload time)
 */
export function buildTurnPayload({ input, window, installSalt, now }) {
  let count = 0;
  /** @type {Set<string>} */
  const kinds = new Set();
  let truncated = false;
  const clean = (text, max) => {
    const r = redactText(text);
    count += r.count;
    for (const k of r.kinds) kinds.add(k);
    if (r.text.length > max) truncated = true;
    return cut(r.text, max);
  };

  const rawAssistant = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  let assistantFinal = clean(rawAssistant, ASSISTANT_FINAL_MAX_CHARS);
  let userPrompt = window.userPrompt === null ? null : clean(window.userPrompt, USER_PROMPT_MAX_CHARS);

  /** @type {Record<string, any>} */
  const turn = { userPrompt, assistantFinal, tools: window.tools.map((t) => ({ name: t.name, ok: t.ok, count: t.count })) };
  if (window.platform) turn.platform = { ...window.platform, mcpTools: [...window.platform.mcpTools] };

  const iso = now.toISOString();
  const payload = {
    v: 1,
    adapter: ADAPTER,
    adapterVersion: SKILL_VERSION,
    idempotencyKey: idempotencyKeyFor(input),
    sessionRef: sha256Hex(`${input.session_id}${installSalt}`),
    sentAt: iso,
    turnEndedAt: iso,
    turn,
    redaction: { count, kinds: [...kinds].filter((k) => /^[a-z_]{1,32}$/.test(k)).sort().slice(0, REDACTION_KINDS_MAX) },
    truncated,
    stopHookActive: input.stop_hook_active === true,
  };

  // Aim for CLIENT_TARGET_BYTES: trim the assistant text first, then the prompt.
  let size = byteLength(JSON.stringify(payload));
  while (size > CLIENT_TARGET_BYTES && (turn.assistantFinal.length > 0 || (turn.userPrompt ?? '').length > 0)) {
    const over = size - CLIENT_TARGET_BYTES;
    // Characters can take up to 3 bytes in UTF-8 (6 once JSON-escaped); cut at least by the excess / 3.
    const step = Math.max(64, Math.ceil(over / 3));
    if (turn.assistantFinal.length > 0) {
      assistantFinal = cut(turn.assistantFinal, Math.max(0, turn.assistantFinal.length - step));
      turn.assistantFinal = assistantFinal;
    } else {
      userPrompt = cut(/** @type {string} */ (turn.userPrompt), Math.max(0, /** @type {string} */ (turn.userPrompt).length - step));
      turn.userPrompt = userPrompt;
    }
    payload.truncated = true;
    size = byteLength(JSON.stringify(payload));
  }
  return payload;
}
