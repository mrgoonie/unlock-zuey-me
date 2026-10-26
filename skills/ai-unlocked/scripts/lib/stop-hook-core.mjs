// Decision logic of the Stop hook, separated from process IO so tests can run it in-process.
//
// Claude Code facts this relies on (https://code.claude.com/docs/en/hooks, verified 2026-10-26):
// - Stop input = common fields (`session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`,
//   `hook_event_name`, …) plus `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`.
// - `agent_id` / `agent_type` are present only when the hook fires inside a subagent; subagents finish with the
//   separate `SubagentStop` event. Either one means "not the learner's main turn": ignore it.
// - `stop_hook_active` is true when Claude is already continuing because a Stop hook blocked. Such a re-fire
//   keeps the same `prompt_id`, so the idempotency key (and the spool file) stays the same.
// - `last_assistant_message` is the documented source of the final text; the transcript may lag behind it.
//
// Order matters for privacy: pause, server back-off, invalid or missing credentials are all checked before the
// transcript is opened, so an unpaired or paused install reads nothing and sends nothing.
import path from 'node:path';
import { readCredentials } from './credentials.mjs';
import { ensureInstallSalt, readState, updateState } from './local-state.mjs';
import { configPaths } from './paths.mjs';
import { isFlushLockLive, writeSpoolItem } from './spool.mjs';
import { readTranscriptWindow } from './transcript-window.mjs';
import { buildTurnPayload } from './turn-payload.mjs';

/**
 * @typedef {'invalid_input' | 'ignored_event' | 'paused' | 'server_blocked' | 'credentials_invalid' | 'no_credentials' | 'spooled'} HookOutcome
 */

/** `~/…` → absolute under `home` (the docs show transcript paths with `~`). */
export function expandHome(p, home) {
  if (typeof p !== 'string') return null;
  if (p === '~' || p.startsWith('~/')) return path.join(home, p.slice(1));
  return path.isAbsolute(p) ? p : null;
}

/**
 * @param {unknown} input parsed Stop hook stdin
 * @param {{ ctx: import('./paths.mjs').PathContext, now?: Date }} options
 * @returns {{ outcome: HookOutcome, spawnFlush: boolean, file?: string }}
 */
export function runStopHook(input, { ctx, now = new Date() }) {
  const none = (/** @type {HookOutcome} */ outcome) => ({ outcome, spawnFlush: false });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return none('invalid_input');
  const event = /** @type {Record<string, unknown>} */ (input);
  if (event.hook_event_name !== 'Stop' || (event.agent_id !== undefined && event.agent_id !== null)) return none('ignored_event');
  if (typeof event.session_id !== 'string' || event.session_id === '') return none('invalid_input');

  const paths = configPaths(ctx);
  const state = readState(paths);
  if (state.paused) return none('paused');
  if (state.serverBlockedUntil > now.getTime()) return none('server_blocked');
  if (state.credentialsInvalid) return none('credentials_invalid');
  if (!readCredentials(paths, ctx.env)) return none('no_credentials');

  const window = readTranscriptWindow(expandHome(event.transcript_path, ctx.home));
  const parser = window.parsed ? 'ok' : 'degraded';
  if (state.parser !== parser) updateState(paths, { parser });
  const installSalt = state.installSalt ?? ensureInstallSalt(paths);
  const payload = buildTurnPayload({
    input: /** @type {import('./turn-payload.mjs').StopInput} */ (event), window, installSalt, now,
  });
  const file = writeSpoolItem(paths, payload, now.getTime());
  const spawnFlush = state.uploadRetryAfter <= now.getTime() && !isFlushLockLive(paths, now.getTime());
  return { outcome: 'spooled', spawnFlush, file };
}
