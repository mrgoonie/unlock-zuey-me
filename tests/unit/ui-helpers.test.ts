import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { conceptSchema, missionSchema, type Concept, type Mission } from '../../src/lib/content/schema';
import type { MissionListItem } from '../../src/lib/learning/types';
import { filterConcepts, isReviewDue, normalizeVi } from '../../src/lib/ui/concept-search';
import { criterionStepIndex, isStepComplete, listItems, stepGaps } from '../../src/lib/ui/mission-steps';
import { parseSnapshot } from '../../src/lib/ui/public-certificate';
import { calibration, didLevelUp, pickNextMission } from '../../src/lib/ui/results-helpers';

const content = join(__dirname, '..', '..', 'content');
const mission: Mission = missionSchema.parse(parse(readFileSync(join(content, 'missions', 'plan-weekend.yaml'), 'utf8')));
const stepOf = <T extends Mission['steps'][number]['type']>(t: T) =>
  mission.steps.find((s) => s.type === t) as Extract<Mission['steps'][number], { type: T }>;

describe('mission steps', () => {
  it('parses list values from arrays or lines', () => {
    expect(listItems([' a ', '', 'b'])).toEqual(['a', 'b']);
    expect(listItems('a\n\n b')).toEqual(['a', 'b']);
    expect(listItems(3)).toEqual([]);
  });

  it('intro is always complete; guided input needs required fields and list minimum', () => {
    expect(isStepComplete(stepOf('intro'), {})).toBe(true);
    const g = stepOf('guided-input');
    expect(stepGaps(g, {}).length).toBe(g.fields.filter((f) => f.required).length);
    const full = Object.fromEntries(g.fields.map((f) => [f.id, f.kind === 'list' ? Array.from({ length: f.min }, (_, i) => `ý ${i}`) : 'x'.repeat(f.min)]));
    expect(isStepComplete(g, { [g.id]: full })).toBe(true);
    const list = g.fields.find((f) => f.kind === 'list');
    if (list) {
      const short = { ...full, [list.id]: ['chỉ một'] };
      expect(stepGaps(g, { [g.id]: short })[0].message).toMatch(/cần thêm/);
    }
  });

  it('verification needs every claim and enough notes', () => {
    const v = stepOf('verification');
    const claims = Object.fromEntries(v.claims.map((c) => [c.id, c.answer]));
    expect(isStepComplete(v, { [v.id]: claims })).toBe(false);
    expect(isStepComplete(v, { [v.id]: { ...claims, [v.notes.id]: 'n'.repeat(v.notes.min) } })).toBe(true);
  });

  it('maps a criterion to the step it checks (or its AI step refs)', () => {
    for (const c of mission.rubric.criteria) {
      const idx = criterionStepIndex(mission, c.id);
      expect(idx).toBeGreaterThanOrEqual(0);
      const expected = c.check?.step ?? c.step_refs[c.step_refs.length - 1];
      expect(mission.steps[idx].id).toBe(expected);
    }
    expect(criterionStepIndex(mission, 'nope')).toBe(-1);
  });
});

describe('results helpers', () => {
  it('calibration compares guess vs actual with friendly copy', () => {
    expect(calibration(null, 0.8)).toBeNull();
    expect(calibration(85, 0.84)).toMatchObject({ guessed: 85, actual: 84, message: expect.stringMatching(/rất sát/) });
    expect(calibration(100, 0.5)?.message).toMatch(/tự tin/);
    expect(calibration(30, 0.9)?.message).toMatch(/tốt hơn/);
    expect(calibration(140, 2)).toMatchObject({ guessed: 100, actual: 100 });
  });

  it('detects a level-up when the gained XP exceeds XP into the new level', () => {
    const level = (xpIntoLevel: number) => ({ id: 'L1' as const, name: 'User', xpIntoLevel, xpForNext: 200 });
    expect(didLevelUp({ xpGained: 50, level: level(20) })).toBe(true);
    expect(didLevelUp({ xpGained: 50, level: level(120) })).toBe(false);
    expect(didLevelUp({ xpGained: 0, level: level(0) })).toBe(false);
    expect(didLevelUp(null)).toBe(false);
  });

  it('picks the next recommended, unfinished mission', () => {
    const item = (id: string, over: Partial<MissionListItem> = {}): MissionListItem => ({
      id, title: id, tagline: '', emoji: '🎯', estimatedMinutes: 10, riskTier: 'low', competencies: [], status: 'new', recommended: false, ...over,
    });
    const list = [item('a'), item('b', { recommended: true, status: 'completed' }), item('c', { recommended: true }), item('cur', { recommended: true })];
    expect(pickNextMission(list, 'cur')?.id).toBe('c');
    expect(pickNextMission(list, 'cur', ['c'])?.id).toBe('a');
    expect(pickNextMission([item('cur')], 'cur')).toBeNull();
  });
});

describe('concept search', () => {
  const concepts: Concept[] = ['context', 'hallucination', 'prompt'].map((f) =>
    conceptSchema.parse(parse(readFileSync(join(content, 'concepts', `${f}.yaml`), 'utf8'))));

  it('normalizes Vietnamese diacritics', () => {
    expect(normalizeVi('Ảo Giác Đây')).toBe('ao giac day');
  });

  it('matches without accents, filters by group, and returns all for an empty query', () => {
    expect(filterConcepts(concepts, '', null)).toHaveLength(concepts.length);
    const ctx = concepts.find((c) => c.id === 'context')!;
    expect(filterConcepts(concepts, normalizeVi(ctx.label_vi), null)[0].id).toBe('context');
    expect(filterConcepts(concepts, 'zzzz-khong-co', null)).toEqual([]);
    expect(filterConcepts(concepts, '', 'advanced').every((c) => c.group === 'advanced')).toBe(true);
  });

  it('flags review-due current facts only after the due date', () => {
    expect(isReviewDue({ review_due_at: '2026-01-01' }, '2026-10-26')).toBe(true);
    expect(isReviewDue({ review_due_at: '2027-01-01' }, '2026-10-26')).toBe(false);
    expect(isReviewDue({}, '2026-10-26')).toBe(false);
  });
});

describe('certificate snapshot', () => {
  it('accepts list or map competencies and drops invalid entries', () => {
    expect(parseSnapshot(JSON.stringify({ competencies: [{ id: 'verify', score: 0.9 }, { id: 'hack', score: 1 }], missionsCompleted: 3 })))
      .toEqual({ competencies: [{ id: 'verify', score: 0.9 }], missionsCompleted: 3 });
    expect(parseSnapshot({ competencies: { describe: 1.4, reflect: 'x' }, completedMissions: ['a', 'b'] }))
      .toEqual({ competencies: [{ id: 'describe', score: 1 }], missionsCompleted: 2 });
    expect(parseSnapshot('{broken')).toEqual({ competencies: [], missionsCompleted: null });
  });
});
