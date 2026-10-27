/** get_run, submit_evidence, get_hint, abandon_mission. Every call is scoped to the token's learner by the learning service. */
import { requireScopes, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import * as learning from '../../learning/service';
import { LEARN_WRITE } from '../mcp-scopes';
import { runTool, toolOk, type McpToolContext } from '../tool-results';
import { answersSchema, runIdSchema, stepIdSchema } from './tool-schemas';

export function registerRunTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool('get_run', {
    title: 'Get a mission run',
    description:
      'Returns one of the learner\'s mission runs: status, current step, saved answers, hints used and rev. '
      + 'Errors: not_found when the run id does not exist for this learner.',
    inputSchema: z.object({ run_id: runIdSchema }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ run_id }) => runTool(ctx, 'get_run', 'read', async () => {
    const run = await learning.getRun({ env: ctx.env }, ctx.learner, run_id);
    return toolOk({ run });
  }));

  server.registerTool('submit_evidence', {
    title: 'Submit evidence for evaluation',
    description:
      'Submits the learner\'s answers for a run, evaluates them against the mission rubric and returns the '
      + 'per-criterion evaluation plus rewards (only when it passed; mission XP is paid once per learner per '
      + 'mission, so a later passing run earns 0 XP). Submit only what the learner actually did or decided. Reuse '
      + 'the same idempotency_key when retrying the same submission: a replay returns the stored result and never '
      + 'grants rewards twice. Errors: not_found (run), conflict (run not in a submittable state), invalid (answers '
      + 'incomplete), forbidden (changes an answer the learner already revealed on the web), budget_exceeded. '
      + 'Needs the learn:write scope.',
    inputSchema: z.object({
      run_id: runIdSchema,
      answers: answersSchema,
      confidence: z.number().int().min(0).max(100).optional()
        .describe('The learner\'s own predicted score 0..100 before seeing the result (calibration)'),
      idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/)
        .describe('Unique per submission attempt, e.g. a UUID; reuse it only to retry the same attempt'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    scopeChallenge: requireScopes(LEARN_WRITE),
  }, ({ run_id, answers, confidence, idempotency_key }) => runTool(ctx, 'submit_evidence', 'write', async () => {
    const result = await learning.submitEvidence({ env: ctx.env }, ctx.learner, run_id, {
      idempotencyKey: idempotency_key, answers, confidence, source: 'mcp',
    });
    const verdict = `Evaluation ${result.evaluation.status} (score ${Math.round(result.evaluation.score * 100)}%).`;
    return toolOk({ ...result }, result.replayed ? `${verdict} (replayed earlier submission)` : verdict);
  }));

  server.registerTool('get_hint', {
    title: 'Get a hint for a step',
    description:
      'Returns a coaching hint for one step of a run. Levels unlock in order: 1 nudge to think, 2 next step, '
      + '3 similar example, 4 direct explanation. Prefer the lowest level that helps; hints used are recorded on '
      + 'the run. Errors: not_found, forbidden (level not unlocked yet: request level n-1 first), invalid (unknown step or '
      + 'level), conflict (run already finished), budget_exceeded. Needs the learn:write scope.',
    inputSchema: z.object({
      run_id: runIdSchema,
      step_id: stepIdSchema,
      level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).describe('Hint level 1..4'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scopeChallenge: requireScopes(LEARN_WRITE),
  }, ({ run_id, step_id, level }) => runTool(ctx, 'get_hint', 'write', async () => {
    const hint = await learning.requestHint({ env: ctx.env }, ctx.learner, run_id, step_id, level);
    return toolOk({ hint });
  }));

  server.registerTool('abandon_mission', {
    title: 'Abandon a mission run',
    description:
      'Stops one of the learner\'s open runs (status becomes abandoned) so the mission can be started over with '
      + 'start_mission. Only when the learner explicitly asks to give up this attempt: its saved answers are no '
      + 'longer graded. No XP or evaluation. Penalties are kept: the next run starts with every answer the learner '
      + 'already revealed filled in and locked, and hints used still cancel the no-hint XP bonus. '
      + 'Calling it again on an abandoned run returns that run unchanged. '
      + 'Errors: not_found (run), conflict (run completed or still being graded). Needs the learn:write scope.',
    inputSchema: z.object({ run_id: runIdSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scopeChallenge: requireScopes(LEARN_WRITE),
  }, ({ run_id }) => runTool(ctx, 'abandon_mission', 'write', async () => {
    const run = await learning.abandonRun({ env: ctx.env }, ctx.learner, run_id);
    return toolOk({ run }, 'Run abandoned. Use start_mission to start the mission over.');
  }));
}
