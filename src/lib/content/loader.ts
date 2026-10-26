/**
 * Runtime content access. YAML under content/ is bundled at build time; the bundle is parsed once per
 * isolate. Only `published` missions are exposed to learners. CI (bun run content:check) guarantees the
 * bundle has no errors, so a runtime error here means a broken build and is thrown loudly.
 */
import { parseContent, type Badge, type ContentBundle, type RawFile } from './parse-content';
import type { Concept, Mission } from './schema';

const toFiles = (mods: Record<string, string>): RawFile[] =>
  Object.entries(mods).map(([path, text]) => ({ path, text }));

let cache: ContentBundle | undefined;

function bundle(): ContentBundle {
  if (cache) return cache;
  const parsed = parseContent({
    missions: toFiles(import.meta.glob('../../../content/missions/*.yaml', { query: '?raw', import: 'default', eager: true })),
    concepts: toFiles(import.meta.glob('../../../content/concepts/*.yaml', { query: '?raw', import: 'default', eager: true })),
    badges: toFiles(import.meta.glob('../../../content/badges.yaml', { query: '?raw', import: 'default', eager: true })),
  });
  if (parsed.errors.length) throw new Error(`content errors:\n${parsed.errors.join('\n')}`);
  cache = parsed;
  return parsed;
}

export const listPublishedMissions = (): Mission[] => bundle().missions.filter((m) => m.status === 'published');
export const getMission = (id: string): Mission | undefined => bundle().missions.find((m) => m.id === id);
export const listConcepts = (): Concept[] => bundle().concepts;
export const getConcept = (id: string): Concept | undefined => bundle().concepts.find((c) => c.id === id);
export const listBadges = (): Badge[] => bundle().badges;
export const getBadge = (id: string): Badge | undefined => bundle().badges.find((b) => b.id === id);
