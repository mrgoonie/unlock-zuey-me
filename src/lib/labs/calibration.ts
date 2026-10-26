/**
 * Calibration: does the learner's confidence match how often they are right? Uses the Brier score
 * (mean squared gap between confidence and outcome), reported as 0..100 where 100 is perfectly calibrated.
 */
export interface Prediction {
  /** Stated confidence, 0..100. */
  confidence: number;
  correct: boolean;
}

const clamp = (n: number) => Math.min(Math.max(Number.isFinite(n) ? n : 0, 0), 100);

export function calibrationScore(predictions: Prediction[]): number | null {
  if (predictions.length === 0) return null;
  const brier =
    predictions.reduce((s, p) => s + (clamp(p.confidence) / 100 - (p.correct ? 1 : 0)) ** 2, 0) /
    predictions.length;
  return Math.round((1 - brier) * 100);
}

export type CalibrationTone = 'over' | 'under' | 'good';

/** Compare average confidence with actual accuracy (both in %). A gap within 15 points counts as good. */
export function calibrationTone(predictions: Prediction[]): CalibrationTone {
  if (predictions.length === 0) return 'good';
  const avgConf = predictions.reduce((s, p) => s + clamp(p.confidence), 0) / predictions.length;
  const accuracy = (predictions.filter((p) => p.correct).length / predictions.length) * 100;
  if (avgConf - accuracy > 15) return 'over';
  if (accuracy - avgConf > 15) return 'under';
  return 'good';
}
