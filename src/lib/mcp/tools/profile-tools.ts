/** get_profile: who the connected learner is and their progress (same data as the web /progress page). */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import * as learning from '../../learning/service';
import { runTool, toolOk, type McpToolContext } from '../tool-results';

export function registerProfileTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool('get_profile', {
    title: 'Get learner profile and progress',
    description:
      'Returns the signed-in AI Unlocked learner (display name, onboarding profile) and their progress: XP, level, '
      + 'streak, competency scores, badges, completed missions and active runs (with run ids to resume via get_run). '
      + 'Call this first to orient yourself.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => runTool(ctx, 'get_profile', 'read', async () => {
    const progress = await learning.getProgress({ env: ctx.env }, ctx.learner);
    const { id, kind, displayName, profile } = ctx.learner;
    return toolOk({ learner: { id, kind, displayName, profile }, progress });
  }));
}
