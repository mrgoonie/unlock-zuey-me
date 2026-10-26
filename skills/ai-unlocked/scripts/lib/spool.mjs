// Local spool of redacted turns waiting for upload. One 0600 JSON file per turn, named by its idempotency key,
// so a `stop_hook_active` re-fire of the same turn replaces the pending file instead of adding one.
// Caps: 50 files, 1 MB total, 24 h age (oldest dropped first). An O_EXCL lock file keeps a single uploader;
// the uploader refreshes it before every request and a lock untouched for 60 s counts as stale (killed uploader).
import fs from 'node:fs';
import path from 'node:path';
import { FLUSH_LOCK_STALE_MS, SPOOL_MAX_AGE_MS, SPOOL_MAX_BYTES, SPOOL_MAX_FILES } from './constants.mjs';
import { ensurePrivateDir, writePrivateFileAtomic } from './private-files.mjs';

const ITEM = /^[0-9a-f]{64}\.json$/;

/**
 * @typedef {{ spool: string, flushLock: string, dir: string }} SpoolPaths
 * @typedef {{ file: string, mtimeMs: number, size: number }} SpoolEntry
 */

/**
 * Spool entries, oldest first. Leftover temp files older than the lock timeout are removed on the way.
 * @param {SpoolPaths} paths
 * @param {number} [now]
 * @returns {SpoolEntry[]}
 */
export function listSpool(paths, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(paths.spool);
  } catch {
    return [];
  }
  /** @type {SpoolEntry[]} */
  const entries = [];
  for (const name of names) {
    const file = path.join(paths.spool, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (ITEM.test(name)) entries.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    else if (name.endsWith('.tmp') && now - st.mtimeMs > FLUSH_LOCK_STALE_MS) fs.rmSync(file, { force: true });
  }
  return entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Drops entries older than 24 h, then the oldest until at most 50 files and 1 MB remain.
 * @param {SpoolPaths} paths
 * @param {number} [now]
 * @returns {number} entries dropped
 */
export function enforceSpoolCaps(paths, now = Date.now()) {
  const entries = listSpool(paths, now);
  let dropped = 0;
  let kept = [];
  for (const e of entries) {
    if (now - e.mtimeMs > SPOOL_MAX_AGE_MS) { fs.rmSync(e.file, { force: true }); dropped++; } else kept.push(e);
  }
  let total = kept.reduce((s, e) => s + e.size, 0);
  while (kept.length > SPOOL_MAX_FILES || total > SPOOL_MAX_BYTES) {
    const oldest = /** @type {SpoolEntry} */ (kept.shift());
    fs.rmSync(oldest.file, { force: true });
    total -= oldest.size;
    dropped++;
  }
  return dropped;
}

/**
 * Writes (or replaces) the spool item for `payload.idempotencyKey`, then applies the caps.
 * @param {SpoolPaths} paths
 * @param {{ idempotencyKey: string }} payload
 * @param {number} [now]
 */
export function writeSpoolItem(paths, payload, now = Date.now()) {
  if (!/^[0-9a-f]{64}$/.test(payload.idempotencyKey)) throw new Error('invalid idempotency key');
  ensurePrivateDir(paths.dir);
  ensurePrivateDir(paths.spool);
  const file = path.join(paths.spool, `${payload.idempotencyKey}.json`);
  writePrivateFileAtomic(file, JSON.stringify({ createdAt: new Date(now).toISOString(), payload }));
  enforceSpoolCaps(paths, now);
  return file;
}

/**
 * The stored payload, or null for a corrupt item (which is deleted).
 * @param {string} file
 */
export function readSpoolItem(file) {
  try {
    const item = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (item && typeof item.payload === 'object' && item.payload !== null) return item.payload;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
  }
  fs.rmSync(file, { force: true });
  return null;
}

/** Deletes every spool item. @param {SpoolPaths} paths */
export function clearSpool(paths) {
  for (const e of listSpool(paths, Number.POSITIVE_INFINITY)) fs.rmSync(e.file, { force: true });
}

/** True when a flush lock exists and was refreshed within the stale window. @param {SpoolPaths} paths */
export function isFlushLockLive(paths, now = Date.now()) {
  try {
    return now - fs.statSync(paths.flushLock).mtimeMs <= FLUSH_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Takes the uploader lock (O_EXCL). A stale lock (left by a killed uploader) is broken once.
 * @param {SpoolPaths} paths
 * @returns {boolean} true when this process now holds the lock
 */
export function acquireFlushLock(paths, now = Date.now()) {
  ensurePrivateDir(paths.dir);
  ensurePrivateDir(paths.spool);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(paths.flushLock, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') return false;
      if (isFlushLockLive(paths, now)) return false;
      fs.rmSync(paths.flushLock, { force: true });
    }
  }
  return false;
}

/** Marks the lock as alive (call before each upload). @param {SpoolPaths} paths */
export function refreshFlushLock(paths) {
  const t = new Date();
  try { fs.utimesSync(paths.flushLock, t, t); } catch { /* lock broken by someone else; keep going */ }
}

/** Releases the lock if this process holds it. @param {SpoolPaths} paths */
export function releaseFlushLock(paths) {
  try {
    const owner = JSON.parse(fs.readFileSync(paths.flushLock, 'utf8'));
    if (owner?.pid === process.pid) fs.rmSync(paths.flushLock, { force: true });
  } catch { /* no lock or unreadable: nothing to release */ }
}
