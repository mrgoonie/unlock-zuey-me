/**
 * The single place for XP and level rules. XP is only ever granted for a passed evaluation, once per learner per
 * mission (the first passing run; finalize-evaluation.ts keys the ledger row by mission id).
 *   base       = estimated_minutes × XP_PER_MINUTE
 *   no-hint    = +20% of base when the run used no hint
 *   calibrated = +20% of base when |confidence/100 − score| ≤ CALIBRATION_TOLERANCE
 */
import type { LevelInfo } from './types';

export const XP_PER_MINUTE = 10;
export const NO_HINT_BONUS_RATIO = 0.2;
export const CALIBRATION_BONUS_RATIO = 0.2;
export const CALIBRATION_TOLERANCE = 0.15;

export const LEVELS: ReadonlyArray<{ id: LevelInfo['id']; name: string; minXp: number }> = [
  { id: 'L0', name: 'Explorer', minXp: 0 },
  { id: 'L1', name: 'User', minXp: 300 },
  { id: 'L2', name: 'Practitioner', minXp: 1200 },
  { id: 'L3', name: 'Builder', minXp: 3000 },
];

export interface MissionXp {
  base: number;
  noHintBonus: number;
  calibrationBonus: number;
  total: number;
}

export function isCalibrated(confidence: number | null | undefined, score: number, within = CALIBRATION_TOLERANCE): boolean {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return false;
  // Small epsilon so exact boundaries (e.g. 0.15) are not lost to floating point.
  return Math.abs(confidence / 100 - score) <= within + 1e-9;
}

export function computeMissionXp(input: {
  estimatedMinutes: number; hintsUsed: number; confidence: number | null; score: number;
}): MissionXp {
  const base = Math.max(0, Math.round(input.estimatedMinutes * XP_PER_MINUTE));
  const noHintBonus = input.hintsUsed === 0 ? Math.round(base * NO_HINT_BONUS_RATIO) : 0;
  const calibrationBonus = isCalibrated(input.confidence, input.score) ? Math.round(base * CALIBRATION_BONUS_RATIO) : 0;
  return { base, noHintBonus, calibrationBonus, total: base + noHintBonus + calibrationBonus };
}

/** `xpForNext` is the size of the current level band (null at the top level): progress = xpIntoLevel / xpForNext. */
export function levelForXp(xp: number): LevelInfo {
  const total = Math.max(0, Math.floor(xp));
  let i = 0;
  while (i + 1 < LEVELS.length && total >= LEVELS[i + 1].minXp) i++;
  const cur = LEVELS[i];
  const next = LEVELS[i + 1];
  return { id: cur.id, name: cur.name, xpIntoLevel: total - cur.minXp, xpForNext: next ? next.minXp - cur.minXp : null };
}
