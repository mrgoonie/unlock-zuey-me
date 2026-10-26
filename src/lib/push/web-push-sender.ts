/**
 * Sends one encrypted Web Push message (RFC 8291 aes128gcm + RFC 8292 VAPID) with
 * @block65/webcrypto-web-push. The payload uses the Declarative Web Push shape (`web_push: 8030`) so
 * iOS 18.4+ can display it without the service worker; public/sw.js reads the same shape everywhere else.
 */
import { buildPushPayload, type PushSubscription, type VapidKeys } from '@block65/webcrypto-web-push';

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushNotificationContent {
  title: string;
  body: string;
  /** Absolute https URL opened on click. */
  url: string;
  tag: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Declarative Web Push message (WebKit explainer). Extra keys are ignored by browsers that don't need them. */
export function declarativePayload(n: PushNotificationContent) {
  return {
    web_push: 8030,
    notification: { title: n.title, body: n.body, navigate: n.url, lang: 'vi', dir: 'ltr', tag: n.tag, silent: false },
  };
}

export function vapidFromEnv(env: Pick<Env, 'VAPID_SUBJECT' | 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY'>): VapidKeys | null {
  if (!env.VAPID_SUBJECT || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

/**
 * Encrypts and POSTs the message to the push service. Returns the push service HTTP status
 * (201 = accepted, 404/410 = subscription gone). Network errors propagate to the caller.
 */
export async function sendWebPush(
  sub: StoredSubscription,
  content: PushNotificationContent,
  vapid: VapidKeys,
  fetchFn: FetchLike = fetch,
): Promise<number> {
  const subscription: PushSubscription = { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } };
  const payload = await buildPushPayload(
    { data: declarativePayload(content), options: { ttl: 4 * 60 * 60, urgency: 'normal', topic: content.tag } },
    subscription,
    vapid,
  );
  const res = await fetchFn(sub.endpoint, { method: 'POST', headers: payload.headers, body: payload.body });
  // Drain the body so the connection is released; push services return tiny bodies.
  await res.body?.cancel().catch(() => undefined);
  return res.status;
}
