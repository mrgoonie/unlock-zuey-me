import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseContent } from '../../src/lib/content/parse-content';

const root = join(__dirname, '..', '..', 'content');
const readDir = (d: string) =>
  readdirSync(join(root, d)).filter((f) => f.endsWith('.yaml')).map((f) => ({ path: f, text: readFileSync(join(root, d, f), 'utf8') }));
const real = () => ({
  missions: readDir('missions'),
  concepts: readDir('concepts'),
  badges: [{ path: 'badges.yaml', text: readFileSync(join(root, 'badges.yaml'), 'utf8') }],
});

describe('content', () => {
  it('ships valid content', () => {
    const r = parseContent(real());
    expect(r.errors).toEqual([]);
    expect(r.missions.find((m) => m.id === 'plan-weekend')?.status).toBe('published');
  });

  it('rejects a mission whose rubric points at a missing field', () => {
    const files = real();
    files.missions = files.missions.map((f) =>
      f.path === 'plan-weekend.yaml' ? { ...f, text: f.text.replace('field: constraints, min: 3', 'field: nope, min: 3') } : f);
    expect(parseContent(files).errors.join('\n')).toMatch(/unknown field nope/);
  });

  it('rejects an unknown concept reference and a bad hint ladder', () => {
    const files = real();
    files.missions = files.missions.map((f) =>
      f.path === 'plan-weekend.yaml' ? { ...f, text: f.text.replace('concept_refs: [prompt,', 'concept_refs: [ghost-concept, prompt,') } : f);
    expect(parseContent(files).errors.join('\n')).toMatch(/unknown concept ref ghost-concept/);
  });

  it('requires review_due_at for current-fact concepts', () => {
    const files = real();
    files.concepts = [...files.concepts, { path: 'x.yaml', text: files.concepts[0].text.replace('id: prompt', 'id: fresh-fact').replace('layer: foundation', 'layer: current-fact') }];
    expect(parseContent(files).errors.join('\n')).toMatch(/current-fact needs review_due_at/);
  });
});
