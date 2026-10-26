/**
 * Options for the /mcp OAuth provider (@cloudflare/workers-oauth-provider). Kept apart from src/worker.ts so
 * Astro pages (/authorize) can build OAuth helpers with getOAuthApi() without importing the worker entry.
 */
import { getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { mcpApiHandler } from './mcp-api-handler';
import { MCP_RESOURCE, MCP_SCOPES, MCP_SITE } from './mcp-scopes';

export function buildOAuthOptions(defaultHandler: ExportedHandler<Env>): OAuthProviderOptions<Env> {
  return {
    apiRoute: '/mcp',
    apiHandler: mcpApiHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...MCP_SCOPES],
    // Advertised in the PRM and 401 challenge so clients ask for both; the consent page lets the user drop write.
    requiredScopes: [...MCP_SCOPES],
    resourceMetadata: {
      resource: MCP_RESOURCE,
      authorization_servers: [MCP_SITE],
      bearer_methods_supported: ['header'],
      resource_name: 'AI Unlocked',
    },
    onError: ({ status, code, internal }) => {
      // Codes and internal reasons only: descriptions may echo client input, and tokens are never included.
      console.warn(`oauth ${status} ${code} ${internal.category}/${internal.reason}`);
    },
  };
}

/** The helpers never call the default handler; Astro pages use this placeholder to build them. */
const helpersOnlyHandler: ExportedHandler<Env> = { fetch: () => new Response('Not found', { status: 404 }) };
let helperOptions: OAuthProviderOptions<Env> | undefined;

/** OAuth helpers (parseAuthRequest, consent, completeAuthorization, purge) for use inside Astro routes. */
export function getOAuthHelpers(env: Env): OAuthHelpers {
  helperOptions ??= buildOAuthOptions(helpersOnlyHandler);
  return getOAuthApi(helperOptions, env);
}
