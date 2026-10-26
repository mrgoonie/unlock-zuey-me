/** Progress summary and the mission list with simple, explainable recommendations. */
import { getBadge, listPublishedMissions } from '../content/loader';
import { COMPETENCIES, type Mission } from '../content/schema';
import {
  badgeGrants, competencyRows, completedMissionIds, conceptsSeenCount, labsDone, sumXp,
} from '../db/progress-queries';
import { listRunsByStatus } from '../db/run-repository';
import { loadStreak } from './activity';
import { effectiveStatus } from './mission-state-machine';
import type { RunDeps } from './mission-runs';
import type { LearnerContext, LearnerProfile, MissionListItem, ProgressSummary } from './types';
import { levelForXp } from './xp-and-levels';

export const MAX_RECOMMENDED = 2;

export async function getProgressImpl(deps: RunDeps, learner: LearnerContext): Promise<ProgressSummary> {
  const db = deps.env.DB;
  const now = deps.now?.() ?? new Date();
  const [xp, streak, comps, grants, completed, open, labs, concepts] = await Promise.all([
    sumXp(db, learner.id), loadStreak(db, learner, now), competencyRows(db, learner.id), badgeGrants(db, learner.id),
    completedMissionIds(db, learner.id), listRunsByStatus(db, learner.id, 'open'), labsDone(db, learner.id), conceptsSeenCount(db, learner.id),
  ]);
  const byId = new Map(comps.map((c) => [c.competency, c]));
  return {
    learner: { id: learner.id, kind: learner.kind, displayName: learner.displayName },
    xp,
    level: levelForXp(xp),
    streak,
    competencies: COMPETENCIES.map((id) => ({ id, score: byId.get(id)?.score ?? 0, evidenceCount: byId.get(id)?.evidence_count ?? 0 })),
    badges: grants.flatMap((g) => {
      const b = getBadge(g.badge_id);
      return b ? [{ id: b.id, name: b.name, emoji: b.emoji, grantedAt: g.granted_at }] : [];
    }),
    completedMissions: completed,
    activeRuns: open.map((r) => ({ id: r.id, missionId: r.missionId, status: effectiveStatus(r, now), currentStep: r.currentStep, updatedAt: r.updatedAt })),
    labsDone: labs,
    conceptsSeen: concepts,
  };
}

/** Higher = better fit for the learner's onboarding answers (goal → persona tag, familiarity → level tag). */
export function recommendationScore(m: Mission, profile: LearnerProfile): number {
  let score = 0;
  if (profile.goal === 'everyday-life' && m.persona_tags.includes('everyday-life')) score += 2;
  if (profile.goal === 'work' && m.persona_tags.includes('work')) score += 2;
  const levelTag = profile.familiarity === 'never' ? 'beginner' : profile.familiarity === 'basic' ? 'basic' : profile.familiarity === 'regular' ? 'advanced' : null;
  if (levelTag && m.persona_tags.includes(levelTag)) score += 1;
  // Learners new to AI start with low-risk missions.
  if ((profile.familiarity ?? 'never') === 'never' && m.risk_tier === 'low') score += 1;
  return score;
}

export function buildMissionList(
  missions: Mission[], profile: LearnerProfile, completed: Set<string>, inProgress: Set<string>,
): MissionListItem[] {
  const status = (id: string): MissionListItem['status'] => (completed.has(id) ? 'completed' : inProgress.has(id) ? 'in_progress' : 'new');
  const recommended = new Set(
    missions
      .filter((m) => !completed.has(m.id))
      .map((m) => ({ id: m.id, s: recommendationScore(m, profile), minutes: m.estimated_minutes }))
      .sort((a, b) => b.s - a.s || a.minutes - b.minutes)
      .slice(0, MAX_RECOMMENDED)
      .map((x) => x.id),
  );
  return missions.map((m) => ({
    id: m.id, title: m.title, tagline: m.tagline, emoji: m.emoji, estimatedMinutes: m.estimated_minutes, riskTier: m.risk_tier,
    competencies: m.competency_targets.map((c) => c.id), status: status(m.id), recommended: recommended.has(m.id),
  }));
}

export async function listMissionsImpl(deps: RunDeps, learner: LearnerContext): Promise<MissionListItem[]> {
  const [completed, open] = await Promise.all([completedMissionIds(deps.env.DB, learner.id), listRunsByStatus(deps.env.DB, learner.id, 'open')]);
  return buildMissionList(listPublishedMissions(), learner.profile, new Set(completed), new Set(open.map((r) => r.missionId)));
}
