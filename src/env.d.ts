/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

/** Worker bindings, vars (wrangler.jsonc) and secrets (wrangler secret put / CI). */
interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** @cloudflare/workers-oauth-provider storage for the /mcp authorization server. */
  OAUTH_KV: KVNamespace;
  /** Rate-limit counters and short-lived caches. */
  CACHE: KVNamespace;
  /** Private evidence screenshots. */
  EVIDENCE: R2Bucket;
  AI: Ai;
  /**
   * Rate Limiting bindings (wrangler.jsonc `ratelimits`, rules in src/lib/identity/request-rate-limits.ts).
   * Optional: without them an in-memory per-isolate limiter with the same rules is used.
   */
  RL_GUEST_IP?: RateLimit;
  RL_AI_IP?: RateLimit;
  RL_WRITE_IP?: RateLimit;
  RL_WRITE_LEARNER?: RateLimit;

  PUBLIC_SITE_URL: string;
  ZUEY_ISSUER: string;
  /** Comma-separated emails allowed into /admin (observer dashboard). */
  ADMIN_EMAILS: string;
  AI_DAILY_BUDGET_USD_PER_LEARNER: string;
  AI_DAILY_BUDGET_USD_GLOBAL: string;
  /** Workers AI calls allowed per UTC day across all learners (falls back to a default when unset). */
  AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL?: string;
  VAPID_SUBJECT: string;

  OPENROUTER_API_KEY?: string;
  /** HMAC key for signed cookies and certificate codes. */
  SESSION_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    /** Set by src/middleware.ts for every page and /api request (guest or member). */
    learner?: import('./lib/learning/types').LearnerContext;
  }
}
