/** list_missions, get_mission, start_mission. */
import { requireScopes, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMission } from '../../content/loader';
import * as learning from '../../learning/service';
import { LEARN_WRITE } from '../mcp-scopes';
import { missionPublicView } from '../mission-public-view';
import { runTool, toolError, toolOk, type McpToolContext } from '../tool-results';
import { missionIdSchema } from './tool-schemas';

export function registerMissionTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool('list_missions', {
    title: 'List missions',
    description:
      'Lists the published AI Unlocked missions (real-life tasks done with AI) with the learner\'s status for each '
      + '(new, in_progress, completed) and which ones are recommended. Use get_mission for the steps of one mission.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => runTool(ctx, 'list_missions', 'read', async () => {
    const missions = await learning.listMissions({ env: ctx.env }, ctx.learner);
    return toolOk({ missions });
  }));

  server.registerTool('get_mission', {
    title: 'Get mission content',
    description:
      'Returns one mission\'s content: outcome, safety notes, and every step with its instructions and the answer '
      + 'field ids to fill (answerFields). Rubric answers are not included: the learner must do the checking. '
      + 'Errors: not_found for an unknown or unpublished mission id (see list_missions).',
    inputSchema: z.object({ mission_id: missionIdSchema }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ mission_id }) => runTool(ctx, 'get_mission', 'read', async () => {
    const mission = getMission(mission_id);
    if (!mission || mission.status !== 'published') return toolError('not_found', `No mission "${mission_id}". Use list_missions.`);
    return toolOk({ mission: missionPublicView(mission) });
  }));

  server.registerTool('start_mission', {
    title: 'Start or resume a mission',
    description:
      'Starts a mission run for the learner, or returns their open run if one exists (idempotent). The run is the '
      + 'same one the learner sees on the web. Returns the run (id, status, currentStep, saved answers, rev). '
      + 'Next: work through the steps from get_mission, then submit_evidence. Needs the learn:write scope.',
    inputSchema: z.object({ mission_id: missionIdSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    scopeChallenge: requireScopes(LEARN_WRITE),
  }, ({ mission_id }) => runTool(ctx, 'start_mission', 'write', async () => {
    const run = await learning.startMission({ env: ctx.env }, ctx.learner, mission_id, 'mcp');
    return toolOk({ run }, `Run ${run.id} is ${run.status}.`);
  }));
}
