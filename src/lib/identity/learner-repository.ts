/**
 * Learner rows → LearnerContext. The context is what the learning service, pages and MCP tools see;
 * `isAdmin` is derived here (member + verified email listed in ADMIN_EMAILS), never stored.
 */
import { z } from 'zod';
import { newId, nowIso, parseJson } from '../db/ids';
import type { LearnerContext, LearnerProfile } from '../learning/types';

export interface LearnerRow {
  id: string;
  kind: 'guest' | 'member';
  zuey_sub: string | null;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  profile_json: string;
  observer_consent: number;
  merged_into: string | null;
  deleted_at: string | null;
}

export const LEARNER_COLUMNS =
  'id, kind, zuey_sub, email, display_name, avatar_url, profile_json, observer_consent, merged_into, deleted_at';

/** Comma-separated ADMIN_EMAILS → normalized set. */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}

const profileSchema = z.object({
  goal: z.enum(['everyday-life', 'work', 'curious']).optional().catch(undefined),
  familiarity: z.enum(['never', 'basic', 'regular']).optional().catch(undefined),
  obstacle: z.enum(['dont-know-what-to-ask', 'dont-trust-answers', 'no-time', 'too-technical']).optional().catch(undefined),
  sound: z.boolean().optional().catch(undefined),
  reducedMotion: z.boolean().optional().catch(undefined),
  timezone: z.string().max(64).optional().catch(undefined),
});

/** Parses profile_json tolerantly: unknown keys and invalid values are dropped, never thrown. */
export function parseProfile(raw: string | null | undefined): LearnerProfile {
  const obj = parseJson<Record<string, unknown>>(raw, {});
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {};
  // The schema comment in 0001 documents snake_case `reduced_motion`; accept both spellings.
  const input = { ...obj, reducedMotion: obj.reducedMotion ?? obj.reduced_motion };
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return {};
  return Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) as LearnerProfile;
}

export function toLearnerContext(row: LearnerRow, adminEmails: Set<string>): LearnerContext {
  const email = row.kind === 'member' ? row.email : null;
  return {
    id: row.id,
    kind: row.kind,
    email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isAdmin: row.kind === 'member' && !!email && adminEmails.has(email.toLowerCase()),
    observerConsent: row.observer_consent === 1,
    profile: parseProfile(row.profile_json),
  };
}

/** An active learner: not deleted and not merged into another learner. */
export async function loadActiveLearner(db: D1Database, id: string): Promise<LearnerRow | null> {
  return db.prepare(
    `SELECT ${LEARNER_COLUMNS} FROM learners WHERE id = ? AND deleted_at IS NULL AND merged_into IS NULL`,
  ).bind(id).first<LearnerRow>();
}

/** Loads the LearnerContext for a learner id (used by the /mcp handler with the token's learnerId). */
export async function loadLearnerContext(env: Pick<Env, 'DB' | 'ADMIN_EMAILS'>, id: string): Promise<LearnerContext | null> {
  const row = await loadActiveLearner(env.DB, id);
  return row ? toLearnerContext(row, parseAdminEmails(env.ADMIN_EMAILS)) : null;
}

/** Statement + row for a fresh guest learner (callers batch it with the session insert). */
export function guestInsert(db: D1Database, now: Date): { row: LearnerRow; stmt: D1PreparedStatement } {
  const ts = nowIso(now);
  const row: LearnerRow = {
    id: newId('lrn'), kind: 'guest', zuey_sub: null, email: null, display_name: null, avatar_url: null,
    profile_json: '{}', observer_consent: 0, merged_into: null, deleted_at: null,
  };
  const stmt = db.prepare(
    `INSERT INTO learners (id, kind, profile_json, observer_consent, created_at, updated_at) VALUES (?, 'guest', '{}', 0, ?, ?)`,
  ).bind(row.id, ts, ts);
  return { row, stmt };
}
