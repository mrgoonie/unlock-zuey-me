/**
 * Editorial invariants for the shipped catalogue, on top of schema validity:
 * mission shape (steps, verification, rubric mix), concept coverage, lab links and badge rule coverage.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseContent } from '../../src/lib/content/parse-content';

const root = join(__dirname, '..', '..', 'content');
const readDir = (d: string) =>
  readdirSync(join(root, d)).filter((f) => f.endsWith('.yaml')).map((f) => ({ path: f, text: readFileSync(join(root, d, f), 'utf8') }));
const bundle = parseContent({
  missions: readDir('missions'),
  concepts: readDir('concepts'),
  badges: [{ path: 'badges.yaml', text: readFileSync(join(root, 'badges.yaml'), 'utf8') }],
});
const published = bundle.missions.filter((m) => m.status === 'published');

describe('content catalogue', () => {
  it('parses without errors', () => {
    expect(bundle.errors).toEqual([]);
  });

  it('ships exactly 8 published missions', () => {
    expect(published).toHaveLength(8);
  });

  it.each(published.map((m) => [m.id, m] as const))('mission %s follows the editorial shape', (_id, m) => {
    const nonIntro = m.steps.filter((s) => s.type !== 'intro');
    expect(nonIntro.length).toBeGreaterThanOrEqual(4);
    expect(nonIntro.length).toBeLessThanOrEqual(7);
    expect(m.estimated_minutes).toBeGreaterThanOrEqual(8);
    expect(m.estimated_minutes).toBeLessThanOrEqual(20);
    expect(m.rubric.pass_score).toBeGreaterThanOrEqual(0.65);
    expect(m.rubric.pass_score).toBeLessThanOrEqual(0.75);

    const types = new Set(m.steps.map((s) => s.type));
    for (const t of ['guided-input', 'ai-task', 'verification', 'reflection'] as const) expect(types).toContain(t);
    for (const s of m.steps) if (s.type === 'verification') expect(s.claims.length).toBeGreaterThanOrEqual(3);

    expect(m.rubric.criteria.length).toBeGreaterThanOrEqual(4);
    const methods = new Set(m.rubric.criteria.map((c) => c.method));
    expect(methods).toEqual(new Set(['deterministic', 'ai']));
    expect(m.concept_refs.length).toBeGreaterThan(0);
    if (m.risk_tier !== 'low') expect(m.safety_notes.length).toBeGreaterThan(0);
  });

  it('links plan-weekend and plan-family-trip as transfer variants of each other', () => {
    const byId = new Map(bundle.missions.map((m) => [m.id, m]));
    expect(byId.get('plan-weekend')?.transfer_variant).toBe('plan-family-trip');
    expect(byId.get('plan-family-trip')?.transfer_variant).toBe('plan-weekend');
  });

  it('covers the buzzword decoder with ~40 concepts across every group', () => {
    expect(bundle.concepts.length).toBeGreaterThanOrEqual(38);
    const groups = new Set(bundle.concepts.map((c) => c.group));
    expect(groups.size).toBe(5);
  });

  it('links each lab from its concept pages', () => {
    const lab = (id: string) => bundle.concepts.find((c) => c.id === id)?.lab;
    expect(lab('token')).toBe('token-predictor');
    expect(lab('context')).toBe('context-lab');
    expect(lab('context-window')).toBe('context-lab');
    expect(lab('hallucination')).toBe('hallucination-detective');
  });

  it('marks current-fact concepts for review with medium-or-lower confidence', () => {
    const facts = bundle.concepts.filter((c) => c.layer === 'current-fact');
    expect(facts.length).toBeGreaterThan(0);
    for (const c of facts) {
      expect(c.review_due_at).toBeDefined();
      expect(c.confidence).not.toBe('high');
    }
  });

  it('uses every badge rule kind', () => {
    const kinds = new Set(bundle.badges.map((b) => b.rule.kind));
    for (const k of [
      'first_pass', 'missions_completed', 'mission_completed', 'competency_score', 'labs_completed',
      'streak_days', 'no_hint_pass', 'calibrated', 'transfer_pass',
    ]) expect(kinds).toContain(k);
  });
});
