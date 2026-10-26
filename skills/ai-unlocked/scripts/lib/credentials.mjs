// Ingestion credentials: `credentials.json` (0600, dir 0700) in the config dir, or the `AI_UNLOCKED_INGEST_TOKEN`
// env override. The token is never printed, logged, written to settings.json or to the project dir; `masked`
// shows only its last 4 characters.
import fs from 'node:fs';
import { INGEST_TOKEN_PATTERN, TOKEN_ENV } from './constants.mjs';
import { normalizeServer } from './paths.mjs';
import { ensurePrivateDir, fileMode, readJsonObject, writePrivateFileAtomic } from './private-files.mjs';

/**
 * @typedef {{ server: string, token: string, label: string | null, expiresAt: string | null, pairedAt: string | null, source: 'file' | 'env' }} Credentials
 */

/**
 * Credentials in effect, or null when there are none (or they are malformed). The env token wins over the file;
 * its server is `AI_UNLOCKED_SERVER` or the default.
 * @param {{ credentials: string }} paths
 * @param {Record<string, string | undefined>} env
 * @returns {Credentials | null}
 */
export function readCredentials(paths, env) {
  const envToken = env[TOKEN_ENV]?.trim();
  if (envToken) {
    if (!INGEST_TOKEN_PATTERN.test(envToken)) return null;
    try {
      return { server: normalizeServer(env.AI_UNLOCKED_SERVER), token: envToken, label: null, expiresAt: null, pairedAt: null, source: 'env' };
    } catch {
      return null;
    }
  }
  const raw = readJsonObject(paths.credentials);
  if (!raw || typeof raw.token !== 'string' || !INGEST_TOKEN_PATTERN.test(raw.token)) return null;
  let server;
  try {
    server = normalizeServer(typeof raw.server === 'string' ? raw.server : undefined);
  } catch {
    return null;
  }
  return {
    server,
    token: raw.token,
    label: typeof raw.label === 'string' ? raw.label : null,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    pairedAt: typeof raw.pairedAt === 'string' ? raw.pairedAt : null,
    source: 'file',
  };
}

/** True when a credentials source exists, without parsing it (cheap check for the hook). */
export function hasCredentialsSource(paths, env) {
  return Boolean(env[TOKEN_ENV]?.trim()) || fs.existsSync(paths.credentials);
}

/**
 * Stores credentials with mode 0600 in a 0700 dir.
 * @param {{ dir: string, credentials: string }} paths
 * @param {{ server: string, token: string, label: string, expiresAt: string }} creds
 */
export function writeCredentials(paths, creds) {
  if (!INGEST_TOKEN_PATTERN.test(creds.token)) throw new Error('Máy chủ trả về token không đúng định dạng.');
  ensurePrivateDir(paths.dir);
  const body = { server: normalizeServer(creds.server), token: creds.token, label: creds.label, expiresAt: creds.expiresAt, pairedAt: new Date().toISOString() };
  writePrivateFileAtomic(paths.credentials, `${JSON.stringify(body, null, 2)}\n`);
}

/** Deletes the credentials file (no error when missing). */
export function deleteCredentials(paths) {
  fs.rmSync(paths.credentials, { force: true });
}

/** `…abcd`: the only form of a token this package ever shows. */
export const maskToken = (token) => `…${token.slice(-4)}`;

/** Mode problems for doctor: the file must be 0600 and the dir 0700 (POSIX only). */
export function credentialModeWarnings(paths, platform) {
  if (platform === 'win32') return [];
  const warnings = [];
  const f = fileMode(paths.credentials);
  if (f !== null && (f & 0o077) !== 0) warnings.push(`credentials.json đang có quyền ${f.toString(8)}, nên là 600`);
  const d = fileMode(paths.dir);
  if (d !== null && (d & 0o077) !== 0) warnings.push(`thư mục cấu hình đang có quyền ${d.toString(8)}, nên là 700`);
  return warnings;
}
