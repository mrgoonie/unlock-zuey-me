/**
 * Reveal keys ("stepId:itemId") and the answer fields a reveal locks. Pure and dependency-free so the
 * browser (autosave restoring locked values) and the server (enforcing the lock) share one definition.
 */

/** Item id of a prediction step (it has a single answer). */
export const PREDICTION_ITEM = 'prediction';
/** Fields a prediction reveal locks: the choice and its confidence. A quiz reveal locks the question's field. */
export const PREDICTION_LOCKED_FIELDS = ['choice', 'confidence'] as const;

export const revealKey = (stepId: string, itemId: string): string => `${stepId}:${itemId}`;

export function splitRevealKey(key: string): { stepId: string; itemId: string } | null {
  const i = key.indexOf(':');
  return i > 0 ? { stepId: key.slice(0, i), itemId: key.slice(i + 1) } : null;
}

/** Answer fields of `stepId` locked by the run's reveals (quiz question ids, or the prediction fields). */
export function lockedFieldIds(revealed: readonly string[], stepId: string): string[] {
  const fields = new Set<string>();
  for (const k of revealed) {
    const parts = splitRevealKey(k);
    if (!parts || parts.stepId !== stepId) continue;
    if (parts.itemId === PREDICTION_ITEM) for (const f of PREDICTION_LOCKED_FIELDS) fields.add(f);
    else fields.add(parts.itemId);
  }
  return [...fields];
}
