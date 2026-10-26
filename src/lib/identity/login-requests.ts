/**
 * Pending "Sign in with zuey.me" requests (login_requests): OAuth `state` + PKCE verifier, bound to the
 * browser's learner, single use, 10 minutes. Also validates `return_to` so the login can never redirect
 * off-site (open redirect).
 */
import { nowIso } from '../db/ids';
import { isWellFormedToken, pkceChallenge, randomToken } from './identity-crypto';

export const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_RETURN_TO = '/home';
const MAX_RETURN_TO_LENGTH = 4096;
const SITE_BASE = 'https://return-to.invalid';

/**
 * Accepts only a same-site relative path ("/missions?x=1"). Rejects absolute and protocol-relative URLs,
 * backslashes, control characters and the auth endpoints themselves (redirect loops); falls back to /home.
 */
export function validateReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > MAX_RETURN_TO_LENGTH) return DEFAULT_RETURN_TO;
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_RETURN_TO;
  let url: URL;
  try {
    url = new URL(raw, SITE_BASE);
  } catch {
    return DEFAULT_RETURN_TO;
  }
  if (url.origin !== SITE_BASE) return DEFAULT_RETURN_TO;
  // Normalization can collapse `/.//evil.com` into `//evil.com`, which a Location header treats as protocol-relative.
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return DEFAULT_RETURN_TO;
  if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) return DEFAULT_RETURN_TO;
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface LoginRequest {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  learnerId: string;
  returnTo: string;
}

/** Creates and stores a login request; the caller sends `state` and `codeChallenge` to zuey.me. */
export async function createLoginRequest(
  db: D1Database, input: { learnerId: string; returnTo: string; now: Date },
): Promise<LoginRequest> {
  const state = randomToken(32);
  const codeVerifier = randomToken(48); // 64 chars, inside RFC 7636's 43..128
  const codeChallenge = await pkceChallenge(codeVerifier);
  const expires = new Date(input.now.getTime() + LOGIN_REQUEST_TTL_MS);
  await db.prepare(
    `INSERT INTO login_requests (state, code_verifier, learner_id, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(state, codeVerifier, input.learnerId, input.returnTo, nowIso(input.now), nowIso(expires)).run();
  return { state, codeVerifier, codeChallenge, learnerId: input.learnerId, returnTo: input.returnTo };
}

export type ConsumeResult =
  | { ok: true; request: Omit<LoginRequest, 'codeChallenge'> }
  | { ok: false; reason: 'invalid_state' | 'expired' };

/** Atomically deletes and returns the request for `state` (single use), rejecting expired ones. */
export async function consumeLoginRequest(db: D1Database, state: string | null, now: Date): Promise<ConsumeResult> {
  if (!isWellFormedToken(state)) return { ok: false, reason: 'invalid_state' };
  const row = await db.prepare(
    'DELETE FROM login_requests WHERE state = ? RETURNING state, code_verifier, learner_id, return_to, expires_at',
  ).bind(state).first<{ state: string; code_verifier: string; learner_id: string | null; return_to: string; expires_at: string }>();
  if (!row || !row.learner_id) return { ok: false, reason: 'invalid_state' };
  if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    request: { state: row.state, codeVerifier: row.code_verifier, learnerId: row.learner_id, returnTo: validateReturnTo(row.return_to) },
  };
}

export async function purgeExpiredLoginRequests(db: D1Database, now: Date): Promise<void> {
  await db.prepare('DELETE FROM login_requests WHERE expires_at <= ?').bind(nowIso(now)).run();
}
