/**
 * Server-side data for learner pages (SSR only). Pages read the learning service directly instead of calling
 * their own /api over HTTP. Failures (service unavailable, no learner) degrade to null so a page still
 * renders from static content rather than erroring; the error is logged once per request.
 */
import type { AstroGlobal } from 'astro';
import { getProgress, listMissions } from '../learning/service';
import type { LearnerContext, MissionListItem, ProgressSummary } from '../learning/types';
import { listPublishedMissions } from '../content/loader';

type Locals = AstroGlobal['locals'];

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`learner page: ${label} unavailable`, err instanceof Error ? err.message : err);
    return null;
  }
}

const depsOf = (locals: Locals) => ({ env: locals.runtime?.env as Env });

export async function loadProgress(locals: Locals): Promise<ProgressSummary | null> {
  const learner = locals.learner;
  if (!learner) return null;
  return safe('progress', () => getProgress(depsOf(locals), learner));
}

/**
 * Mission list with per-learner status. Falls back to the published content (status "new", first three
 * recommended) when the learning service cannot answer, so browsing always works.
 */
export async function loadMissionList(locals: Locals): Promise<MissionListItem[]> {
  const learner: LearnerContext | undefined = locals.learner;
  const fromService = learner ? await safe('missions', () => listMissions(depsOf(locals), learner)) : null;
  if (fromService) return fromService;
  return listPublishedMissions().map((m, i) => ({
    id: m.id,
    title: m.title,
    tagline: m.tagline,
    emoji: m.emoji,
    estimatedMinutes: m.estimated_minutes,
    riskTier: m.risk_tier,
    competencies: m.competency_targets.map((c) => c.id),
    status: 'new',
    recommended: i < 3,
  }));
}

/** Status of one mission for the learner, derived from progress (null progress = new). */
export function missionStatus(progress: ProgressSummary | null, missionId: string): MissionListItem['status'] {
  if (progress?.activeRuns.some((r) => r.missionId === missionId)) return 'in_progress';
  if (progress?.completedMissions.includes(missionId)) return 'completed';
  return 'new';
}
