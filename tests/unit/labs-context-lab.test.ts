import { describe, expect, it } from 'vitest';
import { contextKey, fitToWindow, pickVariant } from '../../src/lib/labs/context-window';
import {
  ALLERGY_MESSAGE_ID, CARD_ORDER, CHECKS, PLAN_VARIANTS, WINDOW_CHAT, WINDOW_SIZES,
} from '../../src/lib/labs/context-lab-data';

const allSubsets = (ids: string[]): string[][] =>
  ids.reduce<string[][]>((acc, id) => [...acc, ...acc.map((s) => [...s, id])], [[]]);

describe('context variants', () => {
  it('builds an order-independent key', () => {
    expect(contextKey(['knee', 'budget'], CARD_ORDER)).toBe('budget+knee');
    expect(contextKey([], CARD_ORDER)).toBe('');
    expect(contextKey(['unknown'], CARD_ORDER)).toBe('');
  });

  it('has an authored answer for every card combination', () => {
    const subsets = allSubsets(CARD_ORDER);
    expect(subsets).toHaveLength(2 ** CARD_ORDER.length);
    const answers = subsets.map((s) => PLAN_VARIANTS[contextKey(s, CARD_ORDER)]);
    expect(answers.every((a) => typeof a === 'string' && a.length > 20)).toBe(true);
    expect(new Set(answers).size).toBe(subsets.length);
  });

  it('falls back to the no-context answer and throws without one', () => {
    expect(pickVariant({ '': 'base', a: 'A' }, ['b'], ['a', 'b'])).toBe('base');
    expect(pickVariant({ '': 'base', a: 'A' }, ['a'], ['a', 'b'])).toBe('A');
    expect(() => pickVariant({ a: 'A' }, [], ['a'])).toThrow();
  });
});

describe('context window', () => {
  const msgs = [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }];
  const cost = () => 10;

  it('keeps the newest messages that fit and drops older ones contiguously', () => {
    const fit = fitToWindow(msgs, 25, cost);
    expect(fit.kept.map((m) => m.text)).toEqual(['c', 'd']);
    expect(fit.dropped.map((m) => m.text)).toEqual(['a', 'b']);
    expect(fit.used).toBe(20);
  });

  it('keeps everything when the budget is large and always keeps the newest message', () => {
    expect(fitToWindow(msgs, 100, cost).dropped).toEqual([]);
    expect(fitToWindow(msgs, 5, cost).kept.map((m) => m.text)).toEqual(['d']);
    expect(fitToWindow([], 5, cost)).toEqual({ kept: [], dropped: [], used: 0 });
  });

  it('makes the allergy message fall off the small table but not the large one', () => {
    const early = fitToWindow(WINDOW_CHAT.slice(0, 2), WINDOW_SIZES.small);
    expect(early.dropped).toEqual([]);
    const small = fitToWindow(WINDOW_CHAT, WINDOW_SIZES.small);
    expect(small.dropped.map((m) => m.id)).toContain(ALLERGY_MESSAGE_ID);
    const large = fitToWindow(WINDOW_CHAT, WINDOW_SIZES.large);
    expect(large.dropped).toEqual([]);
  });

  it('has valid check questions', () => {
    for (const q of Object.values(CHECKS)) {
      expect(q.correct).toBeGreaterThanOrEqual(0);
      expect(q.correct).toBeLessThan(q.options.length);
    }
  });
});
