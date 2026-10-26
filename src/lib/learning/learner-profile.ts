/**
 * Profile updates (PATCH /api/v1/me/profile). The stored profile_json is merged, so keys written by other
 * modules are preserved. Keys follow LearnerProfile (camelCase).
 */
import { z } from 'zod';
import { nowIso, parseJson } from '../db/ids';
import { isValidTimezone } from './learner-day';
import type { RunDeps } from './mission-runs';
import { LearningError, type LearnerContext, type LearnerProfile } from './types';

export const profilePatchSchema = z.object({
  goal: z.enum(['everyday-life', 'work', 'curious']).optional(),
  familiarity: z.enum(['never', 'basic', 'regular']).optional(),
  obstacle: z.enum(['dont-know-what-to-ask', 'dont-trust-answers', 'no-time', 'too-technical']).optional(),
  sound: z.boolean().optional(),
  reducedMotion: z.boolean().optional(),
  timezone: z.string().max(64).refine(isValidTimezone, 'múi giờ không hợp lệ').optional(),
}).strict();

export const displayNameSchema = z.string().trim().min(1).max(60)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001F\u007F]/.test(s), 'tên chứa ký tự không hợp lệ');

export async function updateLearnerProfile(
  deps: RunDeps, learner: LearnerContext, input: { profile?: Partial<LearnerProfile>; displayName?: string },
): Promise<LearnerContext> {
  const patch = profilePatchSchema.safeParse(input.profile ?? {});
  if (!patch.success) throw new LearningError('invalid', patch.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  let displayName: string | undefined;
  if (input.displayName !== undefined) {
    const n = displayNameSchema.safeParse(input.displayName);
    if (!n.success) throw new LearningError('invalid', 'Tên hiển thị cần 1–60 ký tự.');
    displayName = n.data;
  }
  const db = deps.env.DB;
  const row = await db.prepare('SELECT profile_json, display_name FROM learners WHERE id = ? AND deleted_at IS NULL')
    .bind(learner.id).first<{ profile_json: string; display_name: string | null }>();
  if (!row) throw new LearningError('not_found', 'Không tìm thấy hồ sơ.');
  const stored = parseJson<Record<string, unknown>>(row.profile_json, {});
  const merged = { ...stored, ...patch.data };
  const now = deps.now?.() ?? new Date();
  await db.prepare('UPDATE learners SET profile_json = ?, display_name = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(merged), displayName ?? row.display_name, nowIso(now), learner.id).run();
  return { ...learner, displayName: displayName ?? row.display_name, profile: { ...learner.profile, ...patch.data } };
}
