// Uploads spooled turns, oldest first, one at a time, and reacts to each response as the ingest contract says
// (docs/insights-ingest-contract.md, "Responses" → "Hook behaviour" column):
//
//   202                          delete the item
//   400 clock_skew               rebuild sentAt and retry once, then drop
//   400 (other)                  drop the item
//   401                          mark credentials invalid, keep the spool, stop until re-paired
//   403 consent_required         delete the spool, back off 1 h
//   403 origin_forbidden         client bug: drop the item
//   404 feature_off              delete the spool, back off 24 h
//   429 daily_cap                keep the spool, retry after 00:00 UTC
//   429 rate_limited, 5xx, net   keep the spool, stop; the next Stop or `flush` retries
//
// hook.log records only the timestamp, HTTP status and duration (capped at 64 KB).
import fs from 'node:fs';
import { CONSENT_BLOCK_MS, LOG_MAX_BYTES, SERVER_BLOCK_MS } from './constants.mjs';
import { readCredentials } from './credentials.mjs';
import { postTurn } from './ingest-client.mjs';
import { nextUtcMidnight, readState, updateState } from './local-state.mjs';
import {
  acquireFlushLock, clearSpool, enforceSpoolCaps, listSpool, readSpoolItem, refreshFlushLock, releaseFlushLock,
} from './spool.mjs';

/** Appends `<iso> <status> <ms>ms` to hook.log; keeps the newest half when the file grows past 64 KB. */
export function appendHookLog(paths, status, ms) {
  try {
    const line = `${new Date().toISOString()} ${status} ${Math.round(ms)}ms\n`;
    let size = 0;
    try { size = fs.statSync(paths.log).size; } catch { /* new log */ }
    if (size + line.length > LOG_MAX_BYTES) {
      const keep = fs.readFileSync(paths.log, 'utf8').slice(-Math.floor(LOG_MAX_BYTES / 2));
      fs.writeFileSync(paths.log, keep.slice(keep.indexOf('\n') + 1), { mode: 0o600 });
    }
    fs.appendFileSync(paths.log, line, { mode: 0o600 });
  } catch { /* logging must never break an upload */ }
}

/**
 * @typedef {{ uploaded: number, dropped: number, kept: number, stopped: string | null, skipped?: string }} FlushResult
 */

/**
 * Runs one flush. Returns without network when locked, paused, blocked, invalid or unpaired.
 * @param {ReturnType<typeof import('./paths.mjs').configPaths>} paths
 * @param {Record<string, string | undefined>} env
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<FlushResult>}
 */
export async function flushSpool(paths, env, options = {}) {
  /** @type {FlushResult} */
  const result = { uploaded: 0, dropped: 0, kept: 0, stopped: null };
  if (!acquireFlushLock(paths)) return { ...result, skipped: 'locked' };
  try {
    const now = Date.now();
    const state = readState(paths);
    if (state.paused) return { ...result, skipped: 'paused' };
    if (state.credentialsInvalid) return { ...result, skipped: 'credentials_invalid' };
    if (state.serverBlockedUntil > now) return { ...result, skipped: 'server_blocked' };
    if (state.uploadRetryAfter > now) return { ...result, skipped: 'retry_later' };
    const creds = readCredentials(paths, env);
    if (!creds) return { ...result, skipped: 'no_credentials' };

    enforceSpoolCaps(paths);
    /** @type {Set<string>} */
    const seen = new Set();
    for (;;) {
      const pending = listSpool(paths).filter((e) => !seen.has(e.file));
      if (pending.length === 0) break;
      for (const entry of pending) {
        seen.add(entry.file);
        refreshFlushLock(paths);
        const payload = readSpoolItem(entry.file);
        if (!payload) continue;
        const outcome = await sendOne(paths, creds, payload, options.timeoutMs);
        if (outcome === 'delete') { fs.rmSync(entry.file, { force: true }); result.uploaded++; continue; }
        if (outcome === 'drop') { fs.rmSync(entry.file, { force: true }); result.dropped++; continue; }
        result.stopped = outcome;
        if (outcome === 'consent_required' || outcome === 'feature_off') {
          clearSpool(paths);
          const blockMs = outcome === 'consent_required' ? CONSENT_BLOCK_MS : SERVER_BLOCK_MS;
          updateState(paths, { serverBlockedUntil: Date.now() + blockMs, blockReason: outcome });
        } else if (outcome === 'unauthorized') {
          updateState(paths, { credentialsInvalid: true, blockReason: outcome });
        } else if (outcome === 'daily_cap') {
          updateState(paths, { uploadRetryAfter: nextUtcMidnight(Date.now()), blockReason: outcome });
        }
        result.kept = listSpool(paths).length;
        return result;
      }
    }
    if (state.blockReason) updateState(paths, { blockReason: null, uploadRetryAfter: 0 });
    return result;
  } finally {
    releaseFlushLock(paths);
  }
}

/**
 * Sends one payload (fresh `sentAt`, one retry on clock_skew) and maps the response to an action.
 * @returns {Promise<'delete' | 'drop' | 'unauthorized' | 'consent_required' | 'feature_off' | 'daily_cap' | 'retry_later'>}
 */
async function sendOne(paths, creds, payload, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const res = await postTurn(creds.server, creds.token, { ...payload, sentAt: new Date().toISOString() }, timeoutMs);
    appendHookLog(paths, res.status || 'network', Date.now() - started);
    updateState(paths, { lastResult: { status: res.status || 'network', at: new Date().toISOString() } });
    if (res.status >= 200 && res.status < 300) return 'delete';
    if (res.status === 400) {
      if (res.reason === 'clock_skew' && attempt === 0) continue;
      return 'drop';
    }
    if (res.status === 401) return 'unauthorized';
    if (res.status === 403) return res.reason === 'origin_forbidden' ? 'drop' : 'consent_required';
    if (res.status === 404) return 'feature_off';
    if (res.status === 429 && res.reason === 'daily_cap') return 'daily_cap';
    return 'retry_later';
  }
  return 'drop';
}
