/**
 * Cookie sessions. The browser holds a random 32-byte token in the `uz_session` cookie; D1 stores only its
 * SHA-256 (sessions.token_hash), so a database leak cannot be replayed as a cookie. Sessions slide:
 * a request more than a day after the last refresh extends expiry by the full TTL again.
 */
import { newId, nowIso } from '../db/ids';
import { isWellFormedToken, randomToken, sha256Hex } from './identity-crypto';
import { LEARNER_COLUMNS, type LearnerRow } from './learner-repository';

export const SESSION_COOKIE = 'uz_session';
export const SESSION_TTL_SECONDS = 180 * 24 * 60 * 60;
/** Refresh last_seen/expiry (and re-send the cookie) at most once per this interval. */
export const SESSION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

const isLoopbackHost = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** Secure everywhere except plain-http loopback dev servers (where browsers may drop Secure cookies). */
export function sessionCookieOptions(url: URL, maxAge = SESSION_TTL_SECONDS): CookieOptions {
  const secure = !(url.protocol === 'http:' && isLoopbackHost(url.hostname));
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge };
}

export interface NewSession {
  token: string;
  stmt: D1PreparedStatement;
}

/** Insert statement for a new session; the raw token is returned once, for the cookie. */
export async function sessionInsert(db: D1Database, learnerId: string, now: Date): Promise<NewSession> {
  const token = randomToken(32);
  const ts = nowIso(now);
  const expires = nowIso(new Date(now.getTime() + SESSION_TTL_SECONDS * 1000));
  const stmt = db.prepare(
    'INSERT INTO sessions (id, token_hash, learner_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(newId('ses'), await sha256Hex(token), learnerId, ts, expires, ts);
  return { token, stmt };
}

export interface ResolvedSession {
  sessionId: string;
  learner: LearnerRow;
  /** True when the caller should extend the session (touchSession) and re-send the cookie. */
  needsRefresh: boolean;
}

/** Resolves a cookie token to its active learner, or null (unknown, expired, deleted or merged learner). */
export async function resolveSession(db: D1Database, token: string | undefined, now: Date): Promise<ResolvedSession | null> {
  if (!isWellFormedToken(token)) return null;
  const row = await db.prepare(
    `SELECT s.id AS session_id, s.last_seen_at AS session_last_seen, ${LEARNER_COLUMNS.split(', ').map((c) => `l.${c}`).join(', ')}
       FROM sessions s JOIN learners l ON l.id = s.learner_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND l.deleted_at IS NULL AND l.merged_into IS NULL`,
  ).bind(await sha256Hex(token), nowIso(now)).first<LearnerRow & { session_id: string; session_last_seen: string }>();
  if (!row) return null;
  const { session_id, session_last_seen, ...learner } = row;
  const lastSeen = Date.parse(session_last_seen);
  const needsRefresh = !Number.isFinite(lastSeen) || now.getTime() - lastSeen >= SESSION_REFRESH_INTERVAL_MS;
  return { sessionId: session_id, learner, needsRefresh };
}

/** Sliding refresh: extends expiry by the full TTL from now. */
export async function touchSession(db: D1Database, sessionId: string, now: Date): Promise<void> {
  const expires = nowIso(new Date(now.getTime() + SESSION_TTL_SECONDS * 1000));
  await db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').bind(nowIso(now), expires, sessionId).run();
}

/** Statement deleting the session behind a cookie token (no-op for malformed tokens). */
export async function sessionDeleteByToken(db: D1Database, token: string | undefined): Promise<D1PreparedStatement | null> {
  if (!isWellFormedToken(token)) return null;
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token));
}

export async function purgeExpiredSessions(db: D1Database, now: Date): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowIso(now)).run();
}
