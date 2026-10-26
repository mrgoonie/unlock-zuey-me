/**
 * The /mcp server: one McpServer per request (createMcpHandler calls the factory per request), with tools
 * bound to the learner resolved from the access token. Serves 2026-07-28 clients and, through the default
 * `legacy: 'stateless'` fallback, 2025-era clients.
 */
import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import type { McpToolContext } from './tool-results';
import { registerMissionTools } from './tools/mission-tools';
import { registerProfileTools } from './tools/profile-tools';
import { registerRunTools } from './tools/run-tools';

const INSTRUCTIONS =
  'AI Unlocked teaches beginners to do real tasks with AI and verify the results. Help the learner do the work; '
  + 'do not do the thinking or the verification for them. Start with get_profile, pick a mission with list_missions '
  + 'and get_mission, start it with start_mission, and submit only the learner\'s own answers with submit_evidence. '
  + 'Prefer get_hint at the lowest useful level. Learner-facing text is Vietnamese.';

const TOOL_CONTEXT_KEY = 'aiUnlocked';

/** Packs the per-request tool context into AuthInfo.extra (the SDK passes it through to the factory). */
export function withToolContext(auth: Omit<AuthInfo, 'extra'>, ctx: McpToolContext): AuthInfo {
  return { ...auth, extra: { [TOOL_CONTEXT_KEY]: ctx } };
}

export function buildMcpServer(ctx: McpToolContext): McpServer {
  const server = new McpServer({ name: 'ai-unlocked', title: 'AI Unlocked', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  registerProfileTools(server, ctx);
  registerMissionTools(server, ctx);
  registerRunTools(server, ctx);
  return server;
}

export const mcpHandler = createMcpHandler(({ authInfo }) => {
  const ctx = authInfo?.extra?.[TOOL_CONTEXT_KEY] as McpToolContext | undefined;
  // The OAuth provider only routes authenticated requests here; a missing context is a wiring bug.
  if (!ctx) throw new Error('MCP request without learner context');
  return buildMcpServer(ctx);
}, {
  onerror: (err) => console.error('mcp handler error', `${err.name}: ${err.message}`),
});
