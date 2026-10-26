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
  /** Share (0–1) of the global daily AI caps that practice chat and hints may use; grading may use all of it. */
  AI_DAILY_COACH_SHARE?: string;
  VAPID_SUBJECT: string;
  /** ai-tutor insights (src/lib/insights/feature-flags.ts): off (default) | internal | pilot | on. */
  INSIGHTS_MODE?: string;
  /** Comma-separated emails that get insights while INSIGHTS_MODE=pilot (admins always do). */
  INSIGHTS_PILOT_EMAILS?: string;
  /** Days an ai-tutor report is kept (default 90). */
  INSIGHTS_RETENTION_DAYS?: string;
  /** ai-tutor analyses per learner per UTC day (default 12). */
  INSIGHTS_DAILY_ANALYSES_PER_LEARNER?: string;
  /** ai-tutor analyses across all learners per UTC day (default 200). */
  INSIGHTS_DAILY_ANALYSES_GLOBAL?: string;
  /** off (default) | issues | issues_ai_handle; always off without GITHUB_ISSUES_TOKEN. */
  INSIGHTS_GITHUB_ISSUES?: string;
  /** owner/repo that proposals are filed against (default mrgoonie/unlock-zuey-me). */
  INSIGHTS_GITHUB_REPO?: string;

  OPENROUTER_API_KEY?: string;
  /** HMAC key for signed cookies and certificate codes. */
  SESSION_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /**
   * Fine-grained PAT (Issues: write on INSIGHTS_GITHUB_REPO only, rotated every 90 days). Read only by
   * src/lib/insights/github-issue-publisher.ts; never serialised into a response, log line or client bundle.
   */
  GITHUB_ISSUES_TOKEN?: string;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    /** Set by src/middleware.ts for every page and /api request (guest or member). */
    learner?: import('./lib/learning/types').LearnerContext;
  }
}
