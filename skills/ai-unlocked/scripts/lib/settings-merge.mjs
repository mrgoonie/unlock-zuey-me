// Marker-based merge of the ai-unlocked Stop handler into a Claude Code settings file.
//
// Hook config shape (https://code.claude.com/docs/en/hooks, "Configuration"): event -> matcher groups ->
// handlers, e.g. { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "...", "timeout": 10 } ] } ] } }.
// Stop has no matcher support, so a group without `matcher` applies to every Stop. Hooks from user, project
// and local files are combined, not overridden, so foreign handlers keep running next to ours; an identical
// handler in two files runs once ("If you define the same handler in more than one settings file, it runs once").
// Settings files are strict JSON (https://code.claude.com/docs/en/settings, "Edit a settings file"), so a file
// that does not parse is never rewritten.
//
// The planners are pure; `applyToFile` is the only IO and writes atomically with a backup and rollback.
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_MARKER_PREFIX, HOOK_TIMEOUT_SECONDS } from './constants.mjs';

export class SettingsError extends Error {
  /** @param {'invalid_json' | 'invalid_shape' | 'write_failed'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @param {unknown} handler */
export const isMarkerHandler = (handler) =>
  isPlainObject(handler) && typeof handler.command === 'string' && handler.command.includes(HOOK_MARKER_PREFIX);

/** The handler this package registers. Only on `Stop`; never `SubagentStop`. */
export function markerHandler(command) {
  return { type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS };
}

/** @param {any} json */
function assertShape(json) {
  if (!isPlainObject(json)) throw new SettingsError('invalid_shape', 'File settings phải là một JSON object.');
  if (json.hooks === undefined) return;
  if (!isPlainObject(json.hooks)) throw new SettingsError('invalid_shape', '"hooks" trong settings không phải object.');
  for (const [event, groups] of Object.entries(json.hooks)) {
    if (!Array.isArray(groups)) throw new SettingsError('invalid_shape', `"hooks.${event}" không phải mảng.`);
  }
}

/**
 * Every marker handler, as `{event, group, index}` positions.
 * @param {any} json
 */
export function findMarkerHandlers(json) {
  /** @type {Array<{ event: string, group: number, index: number, command: string }>} */
  const found = [];
  if (!isPlainObject(json) || !isPlainObject(json.hooks)) return found;
  for (const [event, groups] of Object.entries(json.hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) return;
      g.hooks.forEach((h, hi) => { if (isMarkerHandler(h)) found.push({ event, group: gi, index: hi, command: h.command }); });
    });
  }
  return found;
}

/** Drops groups left without handlers, then empty events, then an empty `hooks` object. */
function pruneEmpty(json, touched) {
  for (const event of touched) {
    const groups = json.hooks[event];
    json.hooks[event] = groups.filter((g) => !(isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (json.hooks[event].length === 0) delete json.hooks[event];
  }
  if (Object.keys(json.hooks).length === 0) delete json.hooks;
}

/**
 * Install or upgrade: no marker → append one new Stop group; one or more → the first Stop marker is replaced
 * in place, every other marker (any event) is removed. Foreign handlers and every other key are untouched.
 * @param {any} input parsed settings (not mutated)
 * @param {string} command
 * @returns {{ changed: boolean, json: any }}
 */
export function planInstall(input, command) {
  assertShape(input);
  const json = structuredClone(input);
  const handler = markerHandler(command);
  const markers = findMarkerHandlers(json);
  const firstStop = markers.find((m) => m.event === 'Stop');
  if (!firstStop) {
    json.hooks ??= {};
    json.hooks.Stop ??= [];
    json.hooks.Stop.push({ hooks: [handler] });
  } else {
    json.hooks.Stop[firstStop.group].hooks[firstStop.index] = handler;
  }
  // Collapse duplicates: every marker handler other than the one just placed (same object reference) goes.
  const touched = new Set();
  for (const event of Object.keys(json.hooks)) {
    for (const g of json.hooks[event]) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) continue;
      const keep = g.hooks.filter((h) => h === handler || !isMarkerHandler(h));
      if (keep.length !== g.hooks.length) { g.hooks = keep; touched.add(event); }
    }
  }
  pruneEmpty(json, touched);
  return { changed: !deepEqual(input, json), json };
}

/**
 * Uninstall: removes only marker handlers (any event), then groups, events and `hooks` left empty.
 * @param {any} input parsed settings (not mutated)
 * @returns {{ changed: boolean, json: any }}
 */
export function planUninstall(input) {
  assertShape(input);
  if (findMarkerHandlers(input).length === 0) return { changed: false, json: input };
  const json = structuredClone(input);
  const touched = new Set();
  for (const event of Object.keys(json.hooks)) {
    for (const g of json.hooks[event]) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) continue;
      const keep = g.hooks.filter((h) => !isMarkerHandler(h));
      if (keep.length !== g.hooks.length) { g.hooks = keep; touched.add(event); }
    }
  }
  pruneEmpty(json, touched);
  return { changed: true, json };
}

/** Structural equality for JSON values (key order ignored). */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/** Indentation of an existing file (first indented key), so a rewrite keeps the user's formatting. */
function detectIndent(text) {
  const m = /^([ \t]+)"/m.exec(text ?? '');
  return m ? m[1] : 2;
}

/**
 * Minimal unified diff (LCS over lines, 3 lines of context). Settings files are small, so O(n·m) is fine.
 * @param {string} a @param {string} b @param {string} label
 */
export function unifiedDiff(a, b, label) {
  const x = a === '' ? [] : a.replace(/\n$/, '').split('\n');
  const y = b === '' ? [] : b.replace(/\n$/, '').split('\n');
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  /** @type {Array<{ op: ' ' | '-' | '+', line: string, ai: number, bi: number }>} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { ops.push({ op: ' ', line: x[i], ai: i, bi: j }); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push({ op: '+', line: y[j], ai: i, bi: j }); j++; }
    else { ops.push({ op: '-', line: x[i], ai: i, bi: j }); i++; }
  }
  const out = [`--- ${label}`, `+++ ${label} (sau khi đổi)`];
  const CONTEXT = 3;
  const changed = ops.flatMap((o, idx) => (o.op === ' ' ? [] : [idx]));
  // Changes closer than 2·CONTEXT unchanged lines share one hunk.
  /** @type {Array<[number, number]>} */
  const hunks = [];
  for (const idx of changed) {
    const last = hunks[hunks.length - 1];
    if (last && idx - last[1] <= CONTEXT * 2 + 1) last[1] = idx;
    else hunks.push([idx, idx]);
  }
  for (const [first, lastChange] of hunks) {
    const hunk = ops.slice(Math.max(0, first - CONTEXT), Math.min(ops.length, lastChange + CONTEXT + 1));
    const aLen = hunk.filter((o) => o.op !== '+').length;
    const bLen = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${hunk[0].ai + (aLen ? 1 : 0)},${aLen} +${hunk[0].bi + (bLen ? 1 : 0)},${bLen} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
  }
  return `${out.join('\n')}\n`;
}

/** Default file operations; tests inject failures through `options.io`. */
const defaultIo = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  openSync: fs.openSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  copyFileSync: fs.copyFileSync,
  unlinkSync: fs.unlinkSync,
  statSync: fs.statSync,
  mkdirSync: fs.mkdirSync,
  chmodSync: fs.chmodSync,
};

/** Deletes a file, ignoring a missing one or a failure (a leftover backup is not worth failing a good write). */
function removeQuietly(io, file) {
  try { io.unlinkSync(file); } catch { /* already gone or not removable */ }
}

/**
 * Reads, plans and (unless `dryRun`) writes one settings file.
 * - Missing file → planned from `{}`; invalid JSON or shape → SettingsError, nothing written.
 * - Before writing, the original is copied to `<file>.ai-unlocked.bak`; the new text goes to `<file>.ai-unlocked.tmp`,
 *   is fsync'ed, renamed over the file, re-read and re-parsed. Any failure restores the backup (or removes a file
 *   that did not exist before) and throws SettingsError('write_failed').
 * - The backup is removed once the write is verified or the rollback succeeded, so no copy of the settings
 *   (which may hold keys or permissions) is left next to a project file where it could be committed. It is
 *   kept only when the rollback itself failed, for a manual restore.
 * - The file mode and indentation are preserved.
 * @param {string} file
 * @param {(json: any) => { changed: boolean, json: any }} plan
 * @param {{ dryRun?: boolean, io?: Partial<typeof defaultIo> }} [options]
 * @returns {{ file: string, changed: boolean, existed: boolean, diff: string | null }}
 */
export function applyToFile(file, plan, options = {}) {
  const io = { ...defaultIo, ...options.io };
  let original = null;
  try {
    original = io.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw new SettingsError('write_failed', `Không đọc được ${file}: ${err.message}`);
  }
  let parsed = {};
  if (original !== null && original.trim() !== '') {
    try {
      parsed = JSON.parse(original);
    } catch {
      throw new SettingsError('invalid_json', `${file} không phải JSON hợp lệ; không sửa gì. Hãy sửa file rồi chạy lại.`);
    }
  }
  const result = plan(parsed);
  if (!result.changed) return { file, changed: false, existed: original !== null, diff: null };
  const indent = detectIndent(original);
  const text = `${JSON.stringify(result.json, null, indent)}\n`;
  const diff = unifiedDiff(original ?? '', text, file);
  if (options.dryRun) return { file, changed: true, existed: original !== null, diff };

  const backup = `${file}.ai-unlocked.bak`;
  const tmp = `${file}.ai-unlocked.tmp`;
  let mode = 0o644;
  let backedUp = false;
  try {
    io.mkdirSync(path.dirname(file), { recursive: true });
    if (original !== null) {
      mode = io.statSync(file).mode & 0o777;
      io.copyFileSync(file, backup);
      backedUp = true;
    }
    io.writeFileSync(tmp, text, { mode });
    const fd = io.openSync(tmp, 'r+');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    io.chmodSync(tmp, mode);
    io.renameSync(tmp, file);
    const reread = JSON.parse(io.readFileSync(file, 'utf8'));
    if (!deepEqual(reread, result.json)) throw new Error('nội dung ghi ra không khớp');
  } catch (err) {
    try { io.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    let restored = true;
    try {
      if (backedUp) io.copyFileSync(backup, file);
      else if (original === null) io.unlinkSync(file);
    } catch {
      restored = false;
    }
    if (!restored) {
      throw new SettingsError('write_failed', `Ghi ${file} thất bại và không khôi phục được; bản gốc còn ở ${backup} (${err.message}).`);
    }
    if (backedUp) removeQuietly(io, backup);
    throw new SettingsError('write_failed', `Ghi ${file} thất bại, đã khôi phục bản cũ (${err.message}).`);
  }
  if (backedUp) removeQuietly(io, backup);
  return { file, changed: true, existed: original !== null, diff };
}

/**
 * Reads a settings file for inspection (doctor/status) without throwing.
 * @param {string} file
 * @returns {{ exists: boolean, ok: boolean, json: any, error?: string }}
 */
export function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, ok: true, json: {} };
    return { exists: true, ok: false, json: null, error: err.message };
  }
  try {
    return { exists: true, ok: true, json: text.trim() === '' ? {} : JSON.parse(text) };
  } catch {
    return { exists: true, ok: false, json: null, error: 'JSON không hợp lệ' };
  }
}
