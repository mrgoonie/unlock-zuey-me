/**
 * Parses raw YAML content files into validated missions/concepts/badges.
 * Shared by the runtime loader (bundled via import.meta.glob) and scripts/validate-content.ts (reads disk).
 */
import { parse } from 'yaml';
import { z } from 'zod';
import {
  COMPETENCIES, conceptSchema, missionSchema, validateContentGraph, type Concept, type Mission,
} from './schema';

export const badgeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1),
  emoji: z.string().min(1),
  description: z.string().min(1),
  /** When the badge is granted. Evaluated by src/lib/learning after each passed evaluation. */
  rule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('first_pass') }),
    z.object({ kind: z.literal('missions_completed'), count: z.number().int().min(1) }),
    z.object({ kind: z.literal('mission_completed'), mission: z.string() }),
    z.object({ kind: z.literal('competency_score'), competency: z.enum(COMPETENCIES), min: z.number().min(0).max(1) }),
    z.object({ kind: z.literal('labs_completed'), count: z.number().int().min(1) }),
    z.object({ kind: z.literal('streak_days'), count: z.number().int().min(1) }),
    z.object({ kind: z.literal('no_hint_pass') }),
    z.object({ kind: z.literal('calibrated'), within: z.number().min(0).max(1) }),
    z.object({ kind: z.literal('transfer_pass') }),
  ]),
});
export type Badge = z.infer<typeof badgeSchema>;

export interface RawFile {
  path: string;
  text: string;
}

export interface ContentBundle {
  missions: Mission[];
  concepts: Concept[];
  badges: Badge[];
  errors: string[];
}

function parseEach<T>(files: RawFile[], schema: z.ZodType<T>, errors: string[]): T[] {
  const out: T[] = [];
  for (const f of files) {
    let data: unknown;
    try {
      data = parse(f.text);
    } catch (e) {
      errors.push(`${f.path}: invalid YAML (${(e as Error).message})`);
      continue;
    }
    // A file may hold one item or a list of items (badges.yaml, grouped concepts).
    for (const item of Array.isArray(data) ? data : [data]) {
      const r = schema.safeParse(item);
      if (r.success) out.push(r.data);
      else for (const issue of r.error.issues) errors.push(`${f.path}: ${issue.path.join('.') || '(root)'} ${issue.message}`);
    }
  }
  return out;
}

export function parseContent(input: { missions: RawFile[]; concepts: RawFile[]; badges: RawFile[] }): ContentBundle {
  const errors: string[] = [];
  const missions = parseEach(input.missions, missionSchema, errors);
  const concepts = parseEach(input.concepts, conceptSchema, errors);
  const badges = parseEach(input.badges, badgeSchema, errors);
  errors.push(...validateContentGraph({ missions, concepts }));
  const missionIds = new Set(missions.map((m) => m.id));
  for (const b of badges) {
    if (b.rule.kind === 'mission_completed' && !missionIds.has(b.rule.mission)) errors.push(`badge ${b.id}: unknown mission ${b.rule.mission}`);
  }
  return { missions, concepts, badges, errors };
}
