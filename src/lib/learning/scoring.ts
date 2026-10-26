/** Weighted rubric scoring and the competency EMA. Pure functions. */
import type { CompetencyId } from '../content/schema';
import type { CriterionResult, Evaluation } from './types';

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Σ(weight × score) / Σweight, rounded to 3 decimals. 0 for an empty/zero-weight rubric. */
export function weightedScore(criteria: Array<Pick<CriterionResult, 'weight' | 'score'>>): number {
  const total = criteria.reduce((s, c) => s + Math.max(0, c.weight), 0);
  if (total <= 0) return 0;
  const sum = criteria.reduce((s, c) => s + Math.max(0, c.weight) * clamp01(c.score), 0);
  return Math.round((sum / total) * 1000) / 1000;
}

export function decideStatus(score: number, passScore: number): Extract<Evaluation['status'], 'passed' | 'needs_revision'> {
  return score + 1e-9 >= passScore ? 'passed' : 'needs_revision';
}

/** Weighted average criterion score per competency within one evaluation. */
export function competencyAverages(criteria: CriterionResult[]): Map<CompetencyId, number> {
  const acc = new Map<CompetencyId, { w: number; s: number }>();
  for (const c of criteria) {
    const cur = acc.get(c.competency) ?? { w: 0, s: 0 };
    const w = Math.max(0, c.weight);
    acc.set(c.competency, { w: cur.w + w, s: cur.s + w * clamp01(c.score) });
  }
  const out = new Map<CompetencyId, number>();
  for (const [k, v] of acc) if (v.w > 0) out.set(k, v.s / v.w);
  return out;
}

/** Smoothing for the competency EMA once enough evidence exists. */
export const COMPETENCY_ALPHA = 0.3;

/**
 * Bias-corrected EMA: alpha = max(COMPETENCY_ALPHA, 1/(n+1)), so the first evidence sets the score, the
 * second averages, and later evidence moves it by 30%.
 */
export function emaUpdate(previous: { score: number; evidenceCount: number }, observation: number): { score: number; evidenceCount: number } {
  const alpha = Math.max(COMPETENCY_ALPHA, 1 / (previous.evidenceCount + 1));
  const score = clamp01(previous.score) * (1 - alpha) + clamp01(observation) * alpha;
  return { score: Math.round(score * 1000) / 1000, evidenceCount: previous.evidenceCount + 1 };
}
