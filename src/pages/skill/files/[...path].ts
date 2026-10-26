import type { APIRoute } from 'astro';
import { serveSkillFile } from '../../../lib/skill/skill-routes';

/** GET /skill/files/<path>: one file listed in /skill/manifest.json; anything else (or INSIGHTS_MODE off) is 404. */
export const GET: APIRoute = ({ locals, params }) => serveSkillFile(locals.runtime.env, params.path);
