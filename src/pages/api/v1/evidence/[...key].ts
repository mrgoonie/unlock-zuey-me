import { readEvidence } from '../../../../lib/learning/service';
import { withLearner } from '../_route-helpers';

/**
 * Clients may send the key per-segment encoded (`ev/a/b.png`) or fully encoded (`ev%2Fa%2Fb.png`); the
 * rest param keeps `%2F` as-is, so decode once. Malformed escapes become '' (→ 404); the strict key regex
 * in readEvidence still rejects anything that is not `ev/<learner>/<id>.<ext>`.
 */
function decodeKeyParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/**
 * GET /api/v1/evidence/:key → image bytes. Owner only, or an admin while the owner's observer consent is on
 * (checked per request). Anything else is 404 so key existence never leaks.
 */
export const GET = withLearner(async ({ params }, learner, deps) => {
  const obj = await readEvidence(deps.env, learner, decodeKeyParam(String(params.key ?? '')));
  const type = obj.httpMetadata?.contentType;
  return new Response(obj.body, {
    headers: {
      'content-type': type && type.startsWith('image/') ? type : 'application/octet-stream',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'",
    },
  });
});
