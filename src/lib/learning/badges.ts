/**
 * Badge rules (content/badges.yaml). `eligibleBadges` is pure; `grantEligibleBadges` loads the learner's
 * state, inserts new grants (INSERT OR IGNORE keeps a badge single) and emits badge.granted.
 */
import type { CompetencyId, Mission } from '../content/schema';
import type { Badge } from '../content/parse-content';
import { listBadges, listPublishedMissions } from '../content/loader';
import { nowIso } from '../db/ids';
import { badgeGrants, competencyRows, completedMissionIds, labsDone } from '../db/progress-queries';
import { recordEventSafe } from '../observer/events';
import { isCalibrated } from './xp-and-levels';
import type { LearnerContext, Rewards, Source } from './types';

export interface BadgeContext {
  completedMissionIds: Set<string>;
  competency: Map<CompetencyId, number>;
  labsDone: number;
  streakDays: number;
  /** The evaluation that just passed, for per-pass rules (no hint, calibration). */
  pass?: { missionId: string; hintsUsed: number; confidence: number | null; score: number };
}

export function badgeRuleMet(badge: Badge, ctx: BadgeContext, missions: Mission[]): boolean {
  const rule = badge.rule;
  switch (rule.kind) {
    case 'first_pass': return ctx.completedMissionIds.size >= 1;
    case 'missions_completed': return ctx.completedMissionIds.size >= rule.count;
    case 'mission_completed': return ctx.completedMissionIds.has(rule.mission);
    case 'competency_score': return (ctx.competency.get(rule.competency) ?? 0) >= rule.min - 1e-9;
    case 'labs_completed': return ctx.labsDone >= rule.count;
    case 'streak_days': return ctx.streakDays >= rule.count;
    case 'no_hint_pass': return !!ctx.pass && ctx.pass.hintsUsed === 0;
    case 'calibrated': return !!ctx.pass && isCalibrated(ctx.pass.confidence, ctx.pass.score, rule.within);
    case 'transfer_pass': {
      // Just passed a mission whose transfer variant (same skill, different data) was already passed.
      if (!ctx.pass) return false;
      const passed = missions.find((m) => m.id === ctx.pass!.missionId);
      const variant = passed?.transfer_variant;
      return !!variant && variant !== passed.id && ctx.completedMissionIds.has(variant);
    }
  }
}

export function eligibleBadges(badges: Badge[], ctx: BadgeContext, missions: Mission[], alreadyHave: Set<string>): Badge[] {
  return badges.filter((b) => !alreadyHave.has(b.id) && badgeRuleMet(b, ctx, missions));
}

export async function grantEligibleBadges(
  env: Env, learner: LearnerContext,
  input: { streakDays: number; pass?: BadgeContext['pass']; ref: string; source: Source; runId?: string; missionId?: string; now: Date },
): Promise<Rewards['newBadges']> {
  const db = env.DB;
  const [completed, comps, labs, grants] = await Promise.all([
    completedMissionIds(db, learner.id), competencyRows(db, learner.id), labsDone(db, learner.id), badgeGrants(db, learner.id),
  ]);
  const ctx: BadgeContext = {
    completedMissionIds: new Set(completed),
    competency: new Map(comps.map((c) => [c.competency, c.score])),
    labsDone: labs.length,
    streakDays: input.streakDays,
    pass: input.pass,
  };
  const candidates = eligibleBadges(listBadges(), ctx, listPublishedMissions(), new Set(grants.map((g) => g.badge_id)));
  const granted: Rewards['newBadges'] = [];
  for (const b of candidates) {
    const r = await db.prepare('INSERT OR IGNORE INTO badge_grants (learner_id, badge_id, ref, granted_at) VALUES (?, ?, ?, ?)')
      .bind(learner.id, b.id, input.ref, nowIso(input.now)).run();
    if ((r.meta.changes ?? 0) === 0) continue;
    granted.push({ id: b.id, name: b.name, emoji: b.emoji });
    await recordEventSafe(db, {
      learnerId: learner.id, name: 'badge.granted', runId: input.runId, missionId: input.missionId, source: input.source, props: { badgeId: b.id },
    });
  }
  return granted;
}
