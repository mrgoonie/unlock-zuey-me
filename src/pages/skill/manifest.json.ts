import type { APIRoute } from 'astro';
import { serveSkillManifest } from '../../lib/skill/skill-routes';

/** GET /skill/manifest.json: skill version and sha256 of every served file (404 while INSIGHTS_MODE is off). */
export const GET: APIRoute = ({ locals }) => serveSkillManifest(locals.runtime.env);
