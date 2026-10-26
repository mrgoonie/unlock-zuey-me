/**
 * Cron dispatcher (wrangler.jsonc triggers: every 15 minutes, UTC).
 * Each job is independent: one failing job must not stop the others.
 */
import { purgeExpiredAuthData } from '../mcp/oauth-purge';

export async function runScheduledJobs(cron: string, env: Env): Promise<void> {
  const jobs: Array<[string, () => Promise<unknown>]> = [
    // Push reminders (src/lib/push) and OAuth purge (src/lib/mcp) register here.
    ['oauth-purge', () => purgeExpiredAuthData(env)],
  ];
  const results = await Promise.allSettled(jobs.map(([, run]) => run()));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`cron ${cron} job ${jobs[i][0]} failed`, r.reason);
  });
  void env;
}
