import { describe, expect, it } from 'vitest';
import { isVerdictCorrect, RED_FLAGS, scoreVerdicts, tallyRedFlags, VERDICTS, type Claim } from '../../src/lib/labs/detective-scoring';
import { ALL_CLAIMS, DETECTIVE_CASES } from '../../src/lib/labs/hallucination-detective-data';

const claims: Claim[] = [
  { id: 'a', text: 'A', accepted: ['verified'], explain: '', flags: [] },
  { id: 'b', text: 'B', accepted: ['expert', 'needs_lookup'], explain: '', flags: ['number', 'citation'] },
  { id: 'c', text: 'C', accepted: ['needs_lookup'], explain: '', flags: ['number'] },
];

describe('detective scoring', () => {
  it('accepts any listed verdict', () => {
    expect(isVerdictCorrect(claims[1], 'needs_lookup')).toBe(true);
    expect(isVerdictCorrect(claims[1], 'verified')).toBe(false);
  });

  it('scores answered claims and counts unanswered as wrong', () => {
    expect(scoreVerdicts(claims, { a: 'verified', b: 'insufficient' })).toEqual({ score: 1, total: 3 });
    expect(scoreVerdicts(claims, {})).toEqual({ score: 0, total: 3 });
  });

  it('tallies red flags, most frequent first', () => {
    expect(tallyRedFlags(claims)).toEqual([
      { flag: 'number', count: 2 },
      { flag: 'citation', count: 1 },
    ]);
  });
});

describe('detective data', () => {
  it('has unique claim ids and teaches every verdict and red flag', () => {
    expect(DETECTIVE_CASES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ALL_CLAIMS.map((c) => c.id)).size).toBe(ALL_CLAIMS.length);
    const primary = new Set(ALL_CLAIMS.map((c) => c.accepted[0]));
    for (const v of VERDICTS) expect(primary.has(v.id)).toBe(true);
    const flags = new Set(ALL_CLAIMS.flatMap((c) => c.flags));
    for (const f of Object.keys(RED_FLAGS)) expect(flags.has(f as keyof typeof RED_FLAGS)).toBe(true);
  });

  it('gives every claim an explanation', () => {
    for (const c of ALL_CLAIMS) expect(c.explain.length).toBeGreaterThan(20);
  });
});
