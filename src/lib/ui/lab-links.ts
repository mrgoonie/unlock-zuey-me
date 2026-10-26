/**
 * Labs shown on /home. Static list because src/lib/labs/registry.ts (labs module) did not exist when this
 * was written; ids match the concept schema's `lab` enum and the /labs/<id> routes.
 */
import type { Concept } from '../content/schema';
import { LAB_LABEL } from './labels';

export type LabId = NonNullable<Concept['lab']>;

export const LAB_LINKS: Array<{ id: LabId; href: string; name: string; emoji: string; tagline: string }> =
  (Object.keys(LAB_LABEL) as LabId[]).map((id) => ({ id, href: `/labs/${id}`, ...LAB_LABEL[id] }));
