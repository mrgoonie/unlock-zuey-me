import { describe, expect, it } from 'vitest';
import { calibrationScore, calibrationTone } from '../../src/lib/labs/calibration';
import { PREDICT_ROUNDS, TEMPERATURE_ROUND_ID, TOKENIZER_SAMPLES } from '../../src/lib/labs/token-predictor-data';
import { applyTemperature, normalise, sampleIndex, sampleMany, seededRandom, topIndex } from '../../src/lib/labs/token-sampling';
import { countTokensApprox, tokenizeApprox } from '../../src/lib/labs/tokenizer-approx';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const opts = [
  { token: 'a', p: 0.5 },
  { token: 'b', p: 0.3 },
  { token: 'c', p: 0.2 },
];

describe('token sampling', () => {
  it('normalises weights and handles all-zero input', () => {
    expect(sum(normalise([{ token: 'x', p: 2 }, { token: 'y', p: 2 }]).map((o) => o.p))).toBeCloseTo(1);
    expect(normalise([{ token: 'x', p: 0 }, { token: 'y', p: Number.NaN }]).map((o) => o.p)).toEqual([0.5, 0.5]);
  });

  it('keeps the distribution at T=1, sharpens when cold and flattens when hot', () => {
    expect(applyTemperature(opts, 1).map((o) => o.p)).toEqual(normalise(opts).map((o) => o.p).map((p) => expect.closeTo(p)));
    const cold = applyTemperature(opts, 0.2);
    const hot = applyTemperature(opts, 2);
    expect(cold[0].p).toBeGreaterThan(0.9);
    expect(hot[0].p).toBeLessThan(0.5);
    expect(hot[2].p).toBeGreaterThan(0.2);
    expect(sum(hot.map((o) => o.p))).toBeCloseTo(1);
  });

  it('treats a near-zero temperature as greedy', () => {
    expect(applyTemperature(opts, 0).map((o) => o.p)).toEqual([1, 0, 0]);
  });

  it('samples by cumulative probability and is reproducible with a seed', () => {
    expect(sampleIndex(opts, 0)).toBe(0);
    expect(sampleIndex(opts, 0.6)).toBe(1);
    expect(sampleIndex(opts, 0.99)).toBe(2);
    const a = sampleMany(opts, 1000, seededRandom(42));
    expect(a).toEqual(sampleMany(opts, 1000, seededRandom(42)));
    expect(sum(a)).toBe(1000);
    expect(a[0]).toBeGreaterThan(a[2]);
  });
});

describe('tokenizer approximation', () => {
  it('splits Vietnamese syllables with diacritics and keeps leading spaces', () => {
    expect(tokenizeApprox('người đẹp').map((t) => t.text)).toEqual(['ng', 'ười', ' đ', 'ẹp']);
  });

  it('keeps common English words whole and punctuation separate', () => {
    expect(tokenizeApprox('Hello world!').map((t) => t.text)).toEqual(['Hello', ' world', '!']);
  });

  it('is deterministic, NFC-normalises and handles empty input', () => {
    expect(countTokensApprox('')).toBe(0);
    expect(tokenizeApprox('trời'.normalize('NFD'))).toEqual(tokenizeApprox('trời'));
  });

  it('shows Vietnamese costing more tokens than the English sample', () => {
    const [vi, en] = TOKENIZER_SAMPLES;
    expect(countTokensApprox(vi.text)).toBeGreaterThan(countTokensApprox(en.text));
  });
});

describe('calibration', () => {
  it('scores perfect calibration 100 and confident misses low', () => {
    expect(calibrationScore([])).toBeNull();
    expect(calibrationScore([{ confidence: 100, correct: true }, { confidence: 0, correct: false }])).toBe(100);
    expect(calibrationScore([{ confidence: 90, correct: false }])).toBe(19);
  });

  it('detects over- and under-confidence', () => {
    expect(calibrationTone([{ confidence: 90, correct: false }, { confidence: 90, correct: false }])).toBe('over');
    expect(calibrationTone([{ confidence: 30, correct: true }, { confidence: 30, correct: true }])).toBe('under');
    expect(calibrationTone([{ confidence: 70, correct: true }, { confidence: 50, correct: false }])).toBe('good');
  });
});

describe('token predictor data', () => {
  it('has 4 unique options per round and a single clear top pick', () => {
    expect(PREDICT_ROUNDS.length).toBeGreaterThanOrEqual(3);
    for (const r of PREDICT_ROUNDS) {
      expect(r.options).toHaveLength(4);
      expect(new Set(r.options.map((o) => o.token)).size).toBe(4);
      const ps = r.options.map((o) => o.p).sort((a, b) => b - a);
      expect(ps[0]).toBeGreaterThan(ps[1]);
      expect(sum(ps)).toBeCloseTo(1, 5);
      expect(topIndex(r.options)).toBeGreaterThanOrEqual(0);
    }
    expect(PREDICT_ROUNDS.some((r) => r.id === TEMPERATURE_ROUND_ID)).toBe(true);
    // The AI pick must not always sit in the same button position, or the game is trivially gamed.
    expect(new Set(PREDICT_ROUNDS.map((r) => topIndex(r.options))).size).toBeGreaterThan(1);
  });
});
