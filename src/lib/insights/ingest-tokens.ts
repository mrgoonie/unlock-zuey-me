/**
 * Device ingestion tokens (insight_tokens). A token is `aiu_ing_` + 32 random bytes (base64url), minted once
 * by device pairing and shown only to the paired CLI. D1 keeps only its SHA-256 hex, so a database leak
 * cannot be replayed. Scope `insights:write`, 90-day expiry, revocable per device by the learner (Settings)
 * or by the device itself (`DELETE /api/ingest/v1/token`). A learner holds at most
 * MAX_ACTIVE_TOKENS_PER_LEARNER active tokens: minting one more revokes the oldest. The token binds the
 * learner: ingest never reads a learner id from the request body.
 */
import { newId, nowIso } from '../db/ids';
import { randomToken, sha256Hex } from '../identity/identity-crypto';
import { LEARNER_COLUMNS, parseAdminEmails, toLearnerContext, type LearnerRow } from '../identity/learner-repository';
import type { LearnerContext } from '../learning/types';
import {
  INGEST_TOKEN_PATTERN, INGEST_TOKEN_PREFIX, INGEST_TOKEN_TTL_DAYS, MAX_ACTIVE_TOKENS_PER_LEARNER, type IngestAdapter,
} from './ingest-contract';

/** last_used_at is refreshed at most this often, so ingest does not write the token row on every turn. */
export const TOKEN_TOUCH_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export const mintToken = (): string => `${INGEST_TOKEN_PREFIX}${randomToken(32)}`;

/** SHA-256 hex, the form stored in insight_tokens.token_hash (same scheme as session tokens). */
export const hashToken = (raw: string): Promise<string> => sha256Hex(raw);

export interface CreatedToken {
  id: string;
  /** The raw token: returned once, never stored. */
  token: string;
  expiresAt: string;
}

/**
 * Mints and stores a token for an active member, then revokes the learner's oldest active tokens beyond
 * MAX_ACTIVE_TOKENS_PER_LEARNER (revoked_at = now, exactly like a revoke from Settings). Returns null when the
 * learner is gone, merged or not a member any more (the INSERT selects from learners, so the check and the
 * write are one statement). One batch, so the cap holds even when two pairings complete at once.
 */
export async function createToken(
  db: D1Database, learnerId: string, label: string, adapter: IngestAdapter, now: Date = new Date(),
): Promise<CreatedToken | null> {
  const id = newId('itk');
  const token = mintToken();
  const ts = nowIso(now);
  const expiresAt = nowIso(new Date(now.getTime() + INGEST_TOKEN_TTL_DAYS * DAY_MS));
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO insight_tokens (id, learner_id, token_hash, label, adapter, created_at, expires_at)
       SELECT ?, id, ?, ?, ?, ?, ? FROM learners
        WHERE id = ? AND kind = 'member' AND deleted_at IS NULL AND merged_into IS NULL`,
    ).bind(id, await hashToken(token), label, adapter, ts, expiresAt, learnerId),
    // Keeps the newest active tokens (the one just minted first) and revokes the rest; a no-op when the
    // INSERT wrote nothing.
    db.prepare(
      `UPDATE insight_tokens SET revoked_at = ?1
        WHERE id IN (
          SELECT id FROM insight_tokens
           WHERE learner_id = ?2 AND revoked_at IS NULL AND expires_at > ?1
           ORDER BY id = ?3 DESC, created_at DESC, id DESC
           LIMIT -1 OFFSET ${MAX_ACTIVE_TOKENS_PER_LEARNER})
          AND EXISTS (SELECT 1 FROM insight_tokens WHERE id = ?3)`,
    ).bind(ts, learnerId, id),
  ]);
  return inserted.meta.changes ? { id, token, expiresAt } : null;
}

export interface ResolvedIngestToken {
  tokenId: string;
  label: string;
  expiresAt: string;
  lastUsedAt: string | null;
  learner: LearnerContext;
}

/**
 * Resolves a raw bearer token to its active member, or null when it is malformed, unknown, revoked or
 * expired, or the learner was deleted, merged or is not a member.
 */
export async function resolveToken(
  db: D1Database, raw: string | null | undefined, now: Date, adminEmailsRaw?: string,
): Promise<ResolvedIngestToken | null> {
  if (typeof raw !== 'string' || !INGEST_TOKEN_PATTERN.test(raw)) return null;
  const row = await db.prepare(
    `SELECT t.id AS token_id, t.label AS token_label, t.expires_at AS token_expires_at, t.last_used_at AS token_last_used_at,
            ${LEARNER_COLUMNS.split(', ').map((c) => `l.${c}`).join(', ')}
       FROM insight_tokens t JOIN learners l ON l.id = t.learner_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
        AND l.kind = 'member' AND l.deleted_at IS NULL AND l.merged_into IS NULL`,
  ).bind(await hashToken(raw), nowIso(now)).first<LearnerRow & {
    token_id: string; token_label: string; token_expires_at: string; token_last_used_at: string | null;
  }>();
  if (!row) return null;
  const { token_id, token_label, token_expires_at, token_last_used_at, ...learner } = row;
  return {
    tokenId: token_id, label: token_label, expiresAt: token_expires_at, lastUsedAt: token_last_used_at,
    learner: toLearnerContext(learner, parseAdminEmails(adminEmailsRaw)),
  };
}

/** Records use of a token, at most once per TOKEN_TOUCH_INTERVAL_MS. */
export async function touchToken(db: D1Database, token: Pick<ResolvedIngestToken, 'tokenId' | 'lastUsedAt'>, now: Date): Promise<void> {
  const last = token.lastUsedAt ? Date.parse(token.lastUsedAt) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < TOKEN_TOUCH_INTERVAL_MS) return;
  await db.prepare(
    `UPDATE insight_tokens SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?3)`,
  ).bind(nowIso(now), token.tokenId, nowIso(new Date(now.getTime() - TOKEN_TOUCH_INTERVAL_MS))).run();
}

export interface DeviceToken {
  id: string;
  label: string;
  adapter: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

/**
 * The learner's usable devices (not revoked, not expired), newest first. Never exposes the hash. Minting
 * keeps at most MAX_ACTIVE_TOKENS_PER_LEARNER of them; the LIMIT only bounds learners who minted more before
 * the cap existed, until their next pairing revokes the extras.
 */
export async function listTokens(db: D1Database, learnerId: string, now: Date = new Date()): Promise<DeviceToken[]> {
  const r = await db.prepare(
    `SELECT id, label, adapter, created_at, last_used_at, expires_at FROM insight_tokens
      WHERE learner_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC, id LIMIT 50`,
  ).bind(learnerId, nowIso(now)).all<{ id: string; label: string; adapter: string; created_at: string; last_used_at: string | null; expires_at: string }>();
  return r.results.map((t) => ({
    id: t.id, label: t.label, adapter: t.adapter, createdAt: t.created_at, lastUsedAt: t.last_used_at, expiresAt: t.expires_at,
  }));
}

/** Revokes one of the learner's own tokens. False when the id is unknown, already revoked or another learner's. */
export async function revokeToken(db: D1Database, learnerId: string, tokenId: string, now: Date = new Date()): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE insight_tokens SET revoked_at = ? WHERE id = ? AND learner_id = ? AND revoked_at IS NULL`,
  ).bind(nowIso(now), tokenId, learnerId).run();
  return r.meta.changes > 0;
}
