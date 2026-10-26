/**
 * Handlers behind /skill/manifest.json, /skill/install.mjs and /skill/files/<path>. Public (curl from the learner's
 * terminal, no session), but every one answers 404 while INSIGHTS_MODE is off, so nothing about the skill is
 * reachable until the feature is enabled.
 */
import { insightsMode } from '../insights/feature-flags';
import { SKILL_CACHE_CONTROL, SKILL_FILES, skillFileBytes, skillManifest } from './skill-bundle';

type FlagEnv = Pick<Env, 'INSIGHTS_MODE'>;

/** True when the /skill routes exist (any INSIGHTS_MODE other than off). */
export const skillRoutesEnabled = (env: FlagEnv): boolean => insightsMode(env) !== 'off';

const notFound = (): Response =>
  new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** GET /skill/manifest.json */
export async function serveSkillManifest(env: FlagEnv): Promise<Response> {
  if (!skillRoutesEnabled(env)) return notFound();
  return Response.json(await skillManifest(), { headers: { 'cache-control': SKILL_CACHE_CONTROL } });
}

/** GET /skill/files/<path> and /skill/install.mjs: the file bytes as text/plain (never executed by a browser). */
export function serveSkillFile(env: FlagEnv, path: string | undefined): Response {
  if (!skillRoutesEnabled(env) || !path) return notFound();
  const text = SKILL_FILES.get(path);
  if (text === undefined) return notFound();
  return new Response(skillFileBytes(text), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': SKILL_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
    },
  });
}
