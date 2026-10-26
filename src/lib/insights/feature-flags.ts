/**
 * Feature flags and numeric settings of the ai-tutor insights feature. Every insights route, page and cron
 * stage calls `insightsEnabledFor` / `insightsMode` first; with INSIGHTS_MODE unset or unknown everything
 * is off (routes 404, UI hidden, cron no-op).
 *
 * Vars live in wrangler.jsonc `vars`; GITHUB_ISSUES_TOKEN is a secret. Unknown or out-of-range values fall
 * back to the safe default instead of throwing, so a typo in a var can never turn a feature on.
 */
import type { LearnerContext } from '../learning/types';
import type { GithubIssuesMode, InsightsMode } from './insight-types';

type FlagEnv = Pick<Env, 'INSIGHTS_MODE' | 'INSIGHTS_PILOT_EMAILS'>;

export const DEFAULT_INSIGHTS_RETENTION_DAYS = 90;
export const DEFAULT_DAILY_ANALYSES_PER_LEARNER = 12;
export const DEFAULT_DAILY_ANALYSES_GLOBAL = 200;
/** Analyses per (learner, session) per UTC day. Not configurable. */
export const ANALYSES_PER_SESSION_PER_DAY = 3;
/** Processed, skipped and dead queue rows are deleted after this many days. */
export const QUEUE_RETENTION_DAYS = 7;
/** Pending events older than this are skipped as `stale`. */
export const QUEUE_STALE_AFTER_HOURS = 48;
/** GitHub issues filed per UTC day at most. */
export const DAILY_ISSUE_CAP = 3;
export const DEFAULT_GITHUB_REPO = 'mrgoonie/unlock-zuey-me';

const MODES: Record<string, InsightsMode> = { off: 'off', internal: 'internal', pilot: 'pilot', on: 'on' };
const GITHUB_MODES: Record<string, GithubIssuesMode> = { off: 'off', issues: 'issues', issues_ai_handle: 'issues_ai_handle' };

/** INSIGHTS_MODE, normalised; anything unknown is 'off'. */
export function insightsMode(env: Pick<Env, 'INSIGHTS_MODE'>): InsightsMode {
  return MODES[(env.INSIGHTS_MODE ?? '').trim().toLowerCase()] ?? 'off';
}

/** Lower-cased emails from INSIGHTS_PILOT_EMAILS (comma or whitespace separated). */
export function pilotEmails(env: Pick<Env, 'INSIGHTS_PILOT_EMAILS'>): Set<string> {
  return new Set((env.INSIGHTS_PILOT_EMAILS ?? '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/**
 * Whether the insights feature exists for this learner. Members only (guests are ephemeral and MCP is
 * member-only): internal → admins; pilot → admins and INSIGHTS_PILOT_EMAILS; on → every member.
 */
export function insightsEnabledFor(
  env: FlagEnv,
  learner: Pick<LearnerContext, 'kind' | 'email' | 'isAdmin'> | null | undefined,
): boolean {
  const mode = insightsMode(env);
  if (mode === 'off' || !learner || learner.kind !== 'member') return false;
  if (mode === 'on') return true;
  if (learner.isAdmin) return true;
  if (mode === 'pilot') return !!learner.email && pilotEmails(env).has(learner.email.toLowerCase());
  return false;
}

/**
 * Effective GitHub issue mode: INSIGHTS_GITHUB_ISSUES, but always 'off' when GITHUB_ISSUES_TOKEN is missing
 * or the insights feature itself is off, whatever the var says.
 */
export function githubIssuesMode(env: Pick<Env, 'INSIGHTS_MODE' | 'INSIGHTS_GITHUB_ISSUES' | 'GITHUB_ISSUES_TOKEN'>): GithubIssuesMode {
  if (insightsMode(env) === 'off' || !env.GITHUB_ISSUES_TOKEN?.trim()) return 'off';
  return GITHUB_MODES[(env.INSIGHTS_GITHUB_ISSUES ?? '').trim().toLowerCase()] ?? 'off';
}

/** INSIGHTS_GITHUB_REPO as `owner/repo`; anything malformed falls back to the default repository. */
export function githubIssuesRepo(env: Pick<Env, 'INSIGHTS_GITHUB_REPO'>): string {
  const repo = (env.INSIGHTS_GITHUB_REPO ?? '').trim();
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) ? repo : DEFAULT_GITHUB_REPO;
}

/** Parses a positive integer var within [1, max]; anything else returns `fallback`. */
export function positiveIntVar(raw: string | undefined, fallback: number, max: number): number {
  const s = (raw ?? '').trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return n >= 1 && n <= max ? n : fallback;
}

/** Days an ai-tutor report is kept (insight_reports.expires_at), INSIGHTS_RETENTION_DAYS, default 90. */
export const insightsRetentionDays = (env: Pick<Env, 'INSIGHTS_RETENTION_DAYS'>): number =>
  positiveIntVar(env.INSIGHTS_RETENTION_DAYS, DEFAULT_INSIGHTS_RETENTION_DAYS, 3_650);

/** Analyses per learner per UTC day, INSIGHTS_DAILY_ANALYSES_PER_LEARNER, default 12. */
export const dailyAnalysesPerLearner = (env: Pick<Env, 'INSIGHTS_DAILY_ANALYSES_PER_LEARNER'>): number =>
  positiveIntVar(env.INSIGHTS_DAILY_ANALYSES_PER_LEARNER, DEFAULT_DAILY_ANALYSES_PER_LEARNER, 1_000);

/** Analyses across all learners per UTC day, INSIGHTS_DAILY_ANALYSES_GLOBAL, default 200. */
export const dailyAnalysesGlobal = (env: Pick<Env, 'INSIGHTS_DAILY_ANALYSES_GLOBAL'>): number =>
  positiveIntVar(env.INSIGHTS_DAILY_ANALYSES_GLOBAL, DEFAULT_DAILY_ANALYSES_GLOBAL, 100_000);
