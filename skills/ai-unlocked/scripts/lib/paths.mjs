// Resolves every path the skill touches from an injected `{home, cwd, env, platform}`, so tests can point the
// whole package at a temp HOME and never touch the real ~/.claude or ~/.config.
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SERVER, SERVER_ENV, SKILL_NAME } from './constants.mjs';

/**
 * @typedef {{ home: string, cwd: string, env: Record<string, string | undefined>, platform: string }} PathContext
 * @typedef {'user' | 'project' | 'project-shared'} SettingsScope
 */

/** @returns {PathContext} the context of the current process. */
export function processContext() {
  return { home: os.homedir(), cwd: process.cwd(), env: process.env, platform: process.platform };
}

/**
 * Local config dir: `${XDG_CONFIG_HOME:-~/.config}/ai-unlocked` (POSIX), `%APPDATA%\ai-unlocked` (Windows).
 * Holds credentials.json (0600), state.json, spool/ and hook.log; the dir itself is 0700.
 * @param {PathContext} ctx
 */
export function configPaths(ctx) {
  const base = ctx.platform === 'win32'
    ? (ctx.env.APPDATA || path.join(ctx.home, 'AppData', 'Roaming'))
    : (ctx.env.XDG_CONFIG_HOME && path.isAbsolute(ctx.env.XDG_CONFIG_HOME) ? ctx.env.XDG_CONFIG_HOME : path.join(ctx.home, '.config'));
  const dir = path.join(base, SKILL_NAME);
  return {
    dir,
    credentials: path.join(dir, 'credentials.json'),
    state: path.join(dir, 'state.json'),
    spool: path.join(dir, 'spool'),
    flushLock: path.join(dir, 'spool', '.flush.lock'),
    log: path.join(dir, 'hook.log'),
  };
}

/**
 * Claude Code's home-level folder: `~/.claude`, or `CLAUDE_CONFIG_DIR` when set
 * (https://code.claude.com/docs/en/settings: "To keep the home-directory files somewhere else, set CLAUDE_CONFIG_DIR").
 * @param {PathContext} ctx
 */
export function claudeHomeDir(ctx) {
  const custom = ctx.env.CLAUDE_CONFIG_DIR;
  return custom && path.isAbsolute(custom) ? custom : path.join(ctx.home, '.claude');
}

/**
 * Settings files (https://code.claude.com/docs/en/settings, "Settings files and who they affect"):
 * user `~/.claude/settings.json`, shared project `.claude/settings.json` (committed, never written by the
 * installer), project local `.claude/settings.local.json` (personal, kept out of git).
 * @param {PathContext} ctx
 * @returns {Record<SettingsScope, string>}
 */
export function settingsPaths(ctx) {
  return {
    user: path.join(claudeHomeDir(ctx), 'settings.json'),
    project: path.join(ctx.cwd, '.claude', 'settings.local.json'),
    'project-shared': path.join(ctx.cwd, '.claude', 'settings.json'),
  };
}

/**
 * Skill install locations (https://code.claude.com/docs/en/skills): personal `~/.claude/skills/<name>/SKILL.md`,
 * project `.claude/skills/<name>/SKILL.md`.
 * @param {PathContext} ctx
 */
export function skillDirs(ctx) {
  return {
    user: path.join(claudeHomeDir(ctx), 'skills', SKILL_NAME),
    project: path.join(ctx.cwd, '.claude', 'skills', SKILL_NAME),
  };
}

/**
 * Server base URL from `AI_UNLOCKED_SERVER` or the default. Only https, or http on a loopback host (local
 * `wrangler dev` and tests), so a typo can never send the ingestion token over plain HTTP.
 * @param {string | undefined} raw
 * @returns {string} origin without a trailing slash
 */
export function normalizeServer(raw) {
  const value = (raw ?? '').trim() || DEFAULT_SERVER;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Địa chỉ máy chủ không hợp lệ: ${value}`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Máy chủ phải dùng https (http chỉ cho localhost).');
  }
  return url.origin;
}

/** @param {PathContext} ctx */
export const serverFromEnv = (ctx) => normalizeServer(ctx.env[SERVER_ENV]);
