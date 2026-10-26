/**
 * Worker entry (astro.config.mjs → adapter workerEntryPoint).
 *
 * Astro renders every page and /api route through `handle`. The identity module wraps this fetch with
 * the /mcp OAuth provider (src/lib/mcp), and `scheduled` runs the cron jobs declared in wrangler.jsonc.
 */
import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';
import { runScheduledJobs } from './lib/jobs/scheduled-jobs';

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);
  const astroFetch = (request: Request, env: Env, ctx: ExecutionContext) =>
    // The adapter's Env type only knows ASSETS; our Env is a superset.
    handle(manifest, app, request as never, env as never, ctx);

  return {
    default: {
      fetch: astroFetch,
      async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(runScheduledJobs(controller.cron, env));
      },
    } satisfies ExportedHandler<Env>,
  };
}
