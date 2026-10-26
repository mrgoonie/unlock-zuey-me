// Scope-level install/uninstall of the Stop handler on top of settings-merge.
//
// Scopes (https://code.claude.com/docs/en/settings, "Settings files and who they affect"):
// - user    → ~/.claude/settings.json (every project on this machine)
// - project → <project>/.claude/settings.local.json (personal, kept out of git). The committed
//             .claude/settings.json is never written, so teammates never get this hook from the repo.
// Uninstall removes marker handlers only, and for `project` also cleans the shared file in case a marker was
// copied there by hand, plus any `*.ai-unlocked.bak` / `*.ai-unlocked.tmp` left next to the project files by an
// older CLI (a copy of personal settings that could otherwise be committed). Hook edits are picked up live: "Claude Code watches your settings files and reloads
// them when they change ... including edits to ... hooks".
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_MARKER } from './constants.mjs';
import { settingsPaths } from './paths.mjs';
import { applyToFile, findMarkerHandlers, planInstall, planUninstall, readSettings, SettingsError } from './settings-merge.mjs';

/**
 * Handler command: absolute node binary + absolute hook script + marker. Absolute paths keep the hook working
 * when Claude Code runs without the shell PATH of the terminal (e.g. desktop apps, nvm).
 * @param {string} scriptsDir directory holding stop-hook.mjs
 * @param {string} [nodePath]
 */
export function hookCommand(scriptsDir, nodePath = process.execPath) {
  const script = path.join(scriptsDir, 'stop-hook.mjs');
  for (const p of [nodePath, script]) {
    if (/["$`\n\r%]/.test(p)) throw new SettingsError('invalid_shape', `Đường dẫn chứa ký tự không an toàn cho lệnh hook: ${p}`);
  }
  return `"${nodePath}" "${script}" ${HOOK_MARKER}`;
}

/**
 * @param {{ ctx: import('./paths.mjs').PathContext, scope: 'user' | 'project', command: string, dryRun?: boolean }} args
 */
export function installHook({ ctx, scope, command, dryRun = false }) {
  const file = settingsPaths(ctx)[scope];
  return applyToFile(file, (json) => planInstall(json, command), { dryRun });
}

/** Settings files an uninstall of `scope` visits. */
export function uninstallFiles(ctx, scope) {
  const p = settingsPaths(ctx);
  if (scope === 'user') return [p.user];
  if (scope === 'project') return [p.project, p['project-shared']];
  return [p.user, p.project, p['project-shared']];
}

/** Leftover files the settings writer may have left next to a settings file (older CLIs kept the backup). */
export const SETTINGS_LEFTOVER_SUFFIXES = ['.ai-unlocked.bak', '.ai-unlocked.tmp'];

/**
 * Removes marker handlers from every file of `scope`. A file with invalid JSON is reported and left untouched;
 * the others are still processed.
 * @param {{ ctx: import('./paths.mjs').PathContext, scope: 'user' | 'project' | 'all', dryRun?: boolean }} args
 */
export function uninstallHook({ ctx, scope, dryRun = false }) {
  /** @type {Array<{ file: string, changed: boolean, diff: string | null }>} */
  const results = [];
  /** @type {Array<{ file: string, message: string }>} */
  const errors = [];
  /** @type {string[]} */
  const removedLeftovers = [];
  const p = settingsPaths(ctx);
  const projectFiles = new Set([p.project, p['project-shared']]);
  for (const file of uninstallFiles(ctx, scope)) {
    if (!dryRun && projectFiles.has(file)) {
      for (const suffix of SETTINGS_LEFTOVER_SUFFIXES) {
        const leftover = `${file}${suffix}`;
        try {
          fs.rmSync(leftover);
          removedLeftovers.push(leftover);
        } catch (err) {
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') errors.push({ file: leftover, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    if (!fs.existsSync(file)) continue;
    try {
      const r = applyToFile(file, planUninstall, { dryRun });
      results.push({ file, changed: r.changed, diff: r.diff });
    } catch (err) {
      errors.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, errors, removedLeftovers };
}

/** Marker handlers per settings file (for status/doctor). */
export function markerReport(ctx) {
  const p = settingsPaths(ctx);
  return /** @type {const} */ (['user', 'project-shared', 'project']).map((scope) => {
    const s = readSettings(p[scope]);
    return { scope, file: p[scope], exists: s.exists, ok: s.ok, error: s.error ?? null, json: s.json, markers: s.ok ? findMarkerHandlers(s.json) : [] };
  });
}
