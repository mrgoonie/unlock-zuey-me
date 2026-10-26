/** POST /api/v1/push/opened {tag?, url?}: the service worker reports a notification click (push.opened event). */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { json, readBody } from '../../../../lib/http/api-response';
import { recordEventSafe } from '../../../../lib/observer/events';
import { requireLearner } from '../../../../lib/privacy/learner-route-context';

const openedSchema = z.object({ tag: z.string().max(64).optional(), url: z.string().max(512).optional() });

export const POST: APIRoute = async ({ locals, request }) => {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request, openedSchema);
  if ('response' in body) return body.response;
  let path: string | null = null;
  if (body.data.url) {
    try {
      path = new URL(body.data.url, 'https://unlock.invalid').pathname.slice(0, 200);
    } catch {
      path = null;
    }
  }
  await recordEventSafe(ctx.env.DB, { learnerId: ctx.learner.id, name: 'push.opened', props: { tag: body.data.tag ?? null, path } });
  return json({ ok: true });
};
