import type { APIRoute } from 'astro';
import { serveSkillFile } from '../../lib/skill/skill-routes';

/** GET /skill/install.mjs: the bootstrap installer (`curl -fsSL … | node - --scope user`); 404 while INSIGHTS_MODE is off. */
export const GET: APIRoute = ({ locals }) => serveSkillFile(locals.runtime.env, 'scripts/install.mjs');
