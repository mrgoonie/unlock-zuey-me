/**
 * Context-lab logic: which authored answer the fake AI gives for the context cards on the table, and which
 * chat messages still fit in a limited context window.
 */
import { countTokensApprox } from './tokenizer-approx';

/** Canonical key for a set of active card ids, ordered like `cardOrder` ("" when none). */
export function contextKey(active: readonly string[], cardOrder: readonly string[]): string {
  const set = new Set(active);
  return cardOrder.filter((id) => set.has(id)).join('+');
}

/** The authored answer for the active cards; falls back to the no-context answer (key ""). */
export function pickVariant<T>(
  variants: Readonly<Record<string, T>>,
  active: readonly string[],
  cardOrder: readonly string[],
): T {
  const exact = variants[contextKey(active, cardOrder)];
  if (exact !== undefined) return exact;
  const fallback = variants[''];
  if (fallback === undefined) throw new Error('context variants need a "" (no context) answer');
  return fallback;
}

export interface WindowFit<T> {
  kept: T[];
  dropped: T[];
  used: number;
}

/**
 * Keep the newest messages whose token total fits in `budget`; everything older "falls off" the table.
 * The newest message is always kept (real apps truncate it rather than drop it), so `used` may exceed
 * `budget` only in that single-message case.
 */
export function fitToWindow<T extends { text: string }>(
  messages: readonly T[],
  budget: number,
  count: (text: string) => number = countTokensApprox,
): WindowFit<T> {
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = count(messages[i].text);
    if (start < messages.length && used + cost > budget) break;
    used += cost;
    start = i;
  }
  return { kept: messages.slice(start), dropped: messages.slice(0, start), used };
}
