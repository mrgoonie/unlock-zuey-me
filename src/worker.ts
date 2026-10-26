/**
 * Worker entry (astro.config.mjs → adapter workerEntryPoint).
 *
 * The /mcp OAuth provider is the outermost layer: it serves the authorization-server endpoints
 * (/oauth/token, /oauth/register, /.well-known/*), verifies bearer tokens for /mcp and hands everything
 * else, including the /authorize consent page, to Astro (`defaultHandler`). `scheduled` runs the cron jobs
 * declared in wrangler.jsonc.
 */
import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { runScheduledJobs } from './lib/jobs/scheduled-jobs';
import { buildOAuthOptions } from './lib/mcp/oauth-options';

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);
  const astroFetch = (request: Request, env: Env, ctx: ExecutionContext) =>
    // The adapter's Env type only knows ASSETS; our Env is a superset.
    handle(manifest, app, request as never, env as never, ctx);

  const provider = new OAuthProvider<Env>(buildOAuthOptions({ fetch: astroFetch }));

  return {
    default: {
      fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),
      async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(runScheduledJobs(controller.cron, env));
      },
    } satisfies ExportedHandler<Env>,
  };
}
