/**
 * The OAuth provider's apiHandler for /mcp. The provider has already verified the bearer token (audience,
 * expiry) before this runs; here we validate browser Origins, load the learner bound to the token
 * (props.learnerId) and hand the request to the MCP handler with that learner's tool context.
 */
import type { OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { localhostAllowedOrigins, originValidationResponse } from '@modelcontextprotocol/server';
import { loadLearnerContext } from '../identity/learner-repository';
import { MCP_RESOURCE, MCP_RESOURCE_METADATA_URL } from './mcp-scopes';
import { mcpHandler, withToolContext } from './mcp-server-factory';

/** Encrypted into every access token by completeAuthorization on the consent page. */
export interface McpProps {
  learnerId: string;
}

/**
 * Browser-based MCP clients we accept (Origin hostnames). Requests without Origin (native/server clients)
 * pass: the bearer token, not a cookie, authenticates them, so there is no CSRF surface.
 */
const ALLOWED_ORIGIN_HOSTS = ['unlock.zuey.me', 'claude.ai', 'chatgpt.com', 'chat.openai.com', ...localhostAllowedOrigins()];

function invalidToken(description: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer error="invalid_token", error_description="${description}", resource_metadata="${MCP_RESOURCE_METADATA_URL}"`,
    },
  });
}

export async function handleMcpRequest(request: Request, env: Env, ctx: OAuthResourceContext<McpProps>): Promise<Response> {
  const rejected = originValidationResponse(request, ALLOWED_ORIGIN_HOSTS);
  if (rejected) return rejected;

  const learnerId = ctx.props?.learnerId;
  if (typeof learnerId !== 'string' || !learnerId) return invalidToken('token is not bound to a learner');
  let learner;
  try {
    learner = await loadLearnerContext(env, learnerId);
  } catch (err) {
    console.error('mcp learner lookup failed', err instanceof Error ? `${err.name}: ${err.message}` : 'error');
    return Response.json({ error: 'temporarily_unavailable' }, { status: 503, headers: { 'retry-after': '5' } });
  }
  // Deleted or merged learners lose MCP access immediately, whatever the token's remaining lifetime.
  if (!learner || learner.kind !== 'member') return invalidToken('learner account is no longer active');

  const auth = ctx.auth;
  return mcpHandler.fetch(request, {
    authInfo: withToolContext({
      token: auth.token,
      clientId: auth.clientId ?? '',
      scopes: auth.scope,
      expiresAt: auth.expiresAt,
      resource: new URL(auth.audience || MCP_RESOURCE),
      resourceMetadataUrl: MCP_RESOURCE_METADATA_URL,
    }, { env, learner, scopes: auth.scope }),
  });
}

/** Shape the provider expects for `apiHandler` (its ExecutionContext carries `props` and `auth`). */
export const mcpApiHandler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    handleMcpRequest(request, env, ctx as unknown as OAuthResourceContext<McpProps>),
} satisfies ExportedHandler<Env>;
