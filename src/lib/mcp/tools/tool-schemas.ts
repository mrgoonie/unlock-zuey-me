/** Input-schema building blocks shared by the MCP tools (bounded, so a client cannot send huge payloads). */
import { z } from 'zod';

export const missionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/)
  .describe('Mission id from list_missions, e.g. "plan-weekend"');

export const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
  .describe('Run id returned by start_mission or get_profile (activeRuns), e.g. "run_ab12cd34"');

export const stepIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/).describe('Step id from get_mission');

const fieldIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

const answerValueSchema = z.union([
  z.string().max(10_000),
  z.array(z.string().max(2_000)).max(50),
  z.number(), // zod 4 numbers already reject Infinity/NaN
]);

/** {stepId: {fieldId: value}} — the same shape the web app autosaves. */
export const answersSchema = z.record(stepIdSchema, z.record(fieldIdSchema, answerValueSchema))
  .refine((a) => Object.keys(a).length <= 30, 'at most 30 steps')
  .describe('Answers keyed by step id, then answer field id (see answerFields in get_mission). '
    + 'Text fields take strings, list fields string arrays, prediction confidence a number 0..100.');
