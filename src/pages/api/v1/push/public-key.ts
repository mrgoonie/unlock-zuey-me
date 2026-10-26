/** GET /api/v1/push/public-key: the VAPID application server key (public by design) for PushManager.subscribe. */
import type { APIRoute } from 'astro';
import { apiError, json } from '../../../../lib/http/api-response';

export const GET: APIRoute = async ({ locals }) => {
  const key = locals.runtime.env.VAPID_PUBLIC_KEY;
  if (!key) return apiError('unavailable', 'Nhắc nhở tạm thời chưa sẵn sàng.');
  return json({ key });
};
