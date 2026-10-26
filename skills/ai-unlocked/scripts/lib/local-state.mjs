// Local state (`state.json` in the config dir). Read by the Stop hook on every turn, so it stays tiny.
//
// - paused:              learner ran `pause`; the hook reads no transcript and makes no network call.
// - serverBlockedUntil:  epoch ms; set after `403 consent_required` / `404 feature_off` (24 h back-off). The hook
//                        captures nothing until then.
// - uploadRetryAfter:    epoch ms; set after `429 daily_cap` (next 00:00 UTC). Turns still spool, uploads wait.
// - blockReason:         reason of the last block, for `status` / `doctor`.
// - credentialsInvalid:  set after a 401; capture stops until `pair` succeeds again. The spool is kept.
// - installSalt:         random hex mixed into `sessionRef`, so the raw session id never leaves the machine.
// - lastResult:          {status, at} of the last upload attempt (HTTP status or 'network').
// - parser:              'ok' | 'degraded': whether the last transcript window parsed (shown by doctor).
import crypto from 'node:crypto';
import { ensurePrivateDir, readJsonObject, writePrivateFileAtomic } from './private-files.mjs';

/**
 * @typedef {{
 *   paused: boolean,
 *   serverBlockedUntil: number,
 *   uploadRetryAfter: number,
 *   blockReason: string | null,
 *   credentialsInvalid: boolean,
 *   installSalt: string | null,
 *   lastResult: { status: number | string, at: string } | null,
 *   parser: 'ok' | 'degraded' | null,
 * }} LocalState
 */

/** @returns {LocalState} */
export const defaultState = () => ({
  paused: false,
  serverBlockedUntil: 0,
  uploadRetryAfter: 0,
  blockReason: null,
  credentialsInvalid: false,
  installSalt: null,
  lastResult: null,
  parser: null,
});

const finiteOr0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Reads state.json; a missing or corrupt file yields the defaults (never throws).
 * @param {{ state: string }} paths
 * @returns {LocalState}
 */
export function readState(paths) {
  const raw = readJsonObject(paths.state) ?? {};
  const d = defaultState();
  return {
    paused: raw.paused === true,
    serverBlockedUntil: finiteOr0(raw.serverBlockedUntil),
    uploadRetryAfter: finiteOr0(raw.uploadRetryAfter),
    blockReason: typeof raw.blockReason === 'string' ? raw.blockReason.slice(0, 64) : d.blockReason,
    credentialsInvalid: raw.credentialsInvalid === true,
    installSalt: typeof raw.installSalt === 'string' && /^[0-9a-f]{64}$/.test(raw.installSalt) ? raw.installSalt : null,
    lastResult: raw.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null,
    parser: raw.parser === 'ok' || raw.parser === 'degraded' ? raw.parser : null,
  };
}

/**
 * Applies `patch` to the current state and writes it atomically (0600).
 * @param {{ dir: string, state: string }} paths
 * @param {Partial<LocalState>} patch
 * @returns {LocalState}
 */
export function updateState(paths, patch) {
  const next = { ...readState(paths), ...patch };
  ensurePrivateDir(paths.dir);
  writePrivateFileAtomic(paths.state, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * The install salt, created on first use.
 * @param {{ dir: string, state: string }} paths
 */
export function ensureInstallSalt(paths) {
  const state = readState(paths);
  if (state.installSalt) return state.installSalt;
  return /** @type {string} */ (updateState(paths, { installSalt: crypto.randomBytes(32).toString('hex') }).installSalt);
}

/** Next 00:00 UTC after `now` (epoch ms): when a `daily_cap` 429 lifts. */
export function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
