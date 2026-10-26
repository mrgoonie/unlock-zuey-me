import type { APIRoute } from 'astro';
import { buildClientMetadataDocument } from '../../lib/identity/zuey-client-metadata';

/** GET /oauth/zuey-client.json — our Client ID Metadata Document for zuey.me (public, cacheable). */
export const GET: APIRoute = ({ locals }) =>
  Response.json(buildClientMetadataDocument(locals.runtime.env.PUBLIC_SITE_URL), {
    headers: { 'cache-control': 'public, max-age=3600' },
  });
