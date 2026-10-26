import { describe, expect, it, vi } from 'vitest';
import { missionSchema, type Mission, type RubricCheck } from '../../src/lib/content/schema';
import { evaluateAnswers } from '../../src/lib/learning/evaluate-submission';
import { listItems, normalizeForMatch, runCheck, textLength } from '../../src/lib/learning/rubric-checks';

const hints = ['a', 'b', 'c', 'd'];
const ab = [{ id: 'oa', text: 'A' }, { id: 'ob', text: 'B' }];
const mission: Mission = missionSchema.parse({
  schema_version: 1, id: 'test-mission', version: 1, locale: 'vi', status: 'published', title: 'T', tagline: 'T', emoji: '🧪',
  outcome: 'o', why_it_matters: 'w', persona_tags: ['beginner'], estimated_minutes: 10, risk_tier: 'low',
  competency_targets: [{ id: 'verify', weight: 1 }],
  steps: [
    { id: 'form', type: 'guided-input', title: 'F', prompt: 'p', hints, fields: [
      { id: 'goal', label: 'Goal', kind: 'text', min: 5 },
      { id: 'items', label: 'Items', kind: 'list', min: 2 },
    ] },
    { id: 'qz', type: 'quiz', title: 'Q', hints, questions: [
      { id: 'q1', prompt: '1?', options: ab, correct: ['oa'], explanation: 'e' },
      { id: 'q2', prompt: '2?', options: ab, correct: ['oa', 'ob'], explanation: 'e' },
    ] },
    { id: 'vf', type: 'verification', title: 'V', instruction: 'i', hints, notes: { id: 'notes', label: 'N', min: 10 }, claims: [
      { id: 'c1', text: 'x', answer: 'verified', explanation: 'e' },
      { id: 'c2', text: 'y', answer: 'needs_lookup', explanation: 'e' },
    ] },
    { id: 'pr', type: 'prediction', title: 'P', hints, question: '?', options: [{ id: 'yes', text: 'Y' }, { id: 'no', text: 'N' }], correct: 'yes', explanation: 'e' },
    { id: 'rf', type: 'reflection', title: 'R', hints, prompt: 'p', field_id: 'lesson', min: 10 },
  ],
  rubric: { pass_score: 0.5, criteria: [
    { id: 'crit-a', label: 'A', weight: 1, competency: 'verify', method: 'deterministic', check: { kind: 'quiz_score', step: 'qz' } },
    { id: 'crit-b', label: 'B', weight: 1, competency: 'verify', method: 'deterministic', check: { kind: 'claims_score', step: 'vf' } },
  ] },
});

describe('rubric check helpers', () => {
  it('counts code points and list lines', () => {
    expect(textLength('  Kiểm tra  ')).toBe(8);
    expect(textLength(undefined)).toBe(0);
    expect(listItems('a\n\n b \r\nc')).toEqual(['a', 'b', 'c']);
    expect(listItems(['x', ' ', 'y'])).toEqual(['x', 'y']);
  });
  it('normalizes Vietnamese for matching', () => {
    expect(normalizeForMatch('Đường  KIỂM tra')).toBe('duong kiem tra');
  });
});

describe('runCheck', () => {
  it('fields_filled uses each field min', () => {
    const check: RubricCheck = { kind: 'fields_filled', step: 'form', fields: ['goal', 'items'] };
    expect(runCheck(mission, check, { form: { goal: 'hello world', items: ['1', '2'] } }).score).toBe(1);
    const half = runCheck(mission, check, { form: { goal: 'hi', items: ['1', '2'] } });
    expect(half.score).toBe(0.5);
    expect(half.feedback).toContain('1 ô');
    expect(runCheck(mission, check, {}).score).toBe(0);
  });

  it('list_min is proportional and capped at 1', () => {
    const check = { kind: 'list_min', step: 'form', field: 'items', min: 4 } as const;
    expect(runCheck(mission, check, { form: { items: 'a\nb' } }).score).toBe(0.5);
    expect(runCheck(mission, check, { form: { items: ['a', 'b', 'c', 'd', 'e'] } }).score).toBe(1);
    expect(runCheck(mission, check, { form: { items: 'a\nb' } }).feedback).toContain('2/4');
  });

  it('text_min counts trimmed characters', () => {
    const check = { kind: 'text_min', step: 'rf', field: 'lesson', min_chars: 10 } as const;
    expect(runCheck(mission, check, { rf: { lesson: '     12345     ' } }).score).toBe(0.5);
    expect(runCheck(mission, check, { rf: { lesson: 'đủ mười ký tự rồi' } }).score).toBe(1);
    expect(runCheck(mission, check, { rf: { lesson: 42 } }).score).toBe(0);
  });

  it('contains_any matches without diacritics or case', () => {
    const check: RubricCheck = { kind: 'contains_any', step: 'form', field: 'goal', terms: ['Google Maps', 'kiểm tra'] };
    expect(runCheck(mission, check, { form: { goal: 'Mình KIEM TRA lại' } }).score).toBe(1);
    expect(runCheck(mission, check, { form: { goal: 'google   maps nói vậy' } }).score).toBe(1);
    expect(runCheck(mission, check, { form: { goal: 'không có gì' } }).score).toBe(0);
  });

  it('quiz_score requires exact option sets', () => {
    const check = { kind: 'quiz_score', step: 'qz' } as const;
    expect(runCheck(mission, check, { qz: { q1: 'oa', q2: ['ob', 'oa'] } }).score).toBe(1);
    expect(runCheck(mission, check, { qz: { q1: ['oa'], q2: ['oa'] } }).score).toBe(0.5);
    expect(runCheck(mission, check, { qz: { q1: 'ob', q2: ['oa', 'ob', 'ob'] } }).score).toBe(0);
  });

  it('claims_score counts matching verdicts', () => {
    const check = { kind: 'claims_score', step: 'vf' } as const;
    expect(runCheck(mission, check, { vf: { c1: 'verified', c2: 'needs_lookup' } }).score).toBe(1);
    expect(runCheck(mission, check, { vf: { c1: 'verified', c2: 'expert' } }).score).toBe(0.5);
  });

  it('prediction_correct', () => {
    const check = { kind: 'prediction_correct', step: 'pr' } as const;
    expect(runCheck(mission, check, { pr: { choice: 'yes', confidence: 70 } }).score).toBe(1);
    expect(runCheck(mission, check, { pr: { choice: 'no' } }).score).toBe(0);
  });

  it('a check pointing at the wrong step type scores 0 instead of throwing', () => {
    expect(runCheck(mission, { kind: 'quiz_score', step: 'vf' }, {}).score).toBe(0);
    expect(runCheck(mission, { kind: 'claims_score', step: 'missing' }, {}).score).toBe(0);
  });
});

describe('evaluateAnswers on a deterministic-only rubric', () => {
  it('never calls a model and builds Vietnamese feedback', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('must not call AI'); }) as unknown as typeof fetch;
    const env = { DB: {}, AI: { run: vi.fn(async () => { throw new Error('must not call AI'); }) } } as unknown as Env;
    const draft = await evaluateAnswers({ env, fetchImpl }, {
      learnerId: 'lrn_x', runId: 'run_x', mission, imageCount: 0,
      answers: { qz: { q1: 'oa', q2: ['oa', 'ob'] }, vf: { c1: 'verified', c2: 'expert' } },
    });
    expect(draft).toMatchObject({ status: 'passed', score: 0.75, mode: 'deterministic', graderModel: null });
    expect(draft.criteria.map((c) => c.id)).toEqual(['crit-a', 'crit-b']);
    expect(draft.feedback).toContain('75%');
    expect(draft.improvements.join(' ')).toContain('1/2');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
