import { describe, expect, it, vi } from 'vitest';
import { sendWebPush, vapidFromEnv } from '../../src/lib/push/web-push-sender';
import { decryptPushBody, makeBrowserSubscription, makeVapidKeys, verifyVapidJwt } from './push-test-crypto';

describe('sendWebPush', () => {
  it('builds an aes128gcm + VAPID request with the library and a declarative payload', async () => {
    const vapid = await makeVapidKeys();
    const sub = await makeBrowserSubscription('https://fcm.googleapis.com/fcm/send/abc');
    const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));

    const status = await sendWebPush(
      sub,
      { title: 'Xin chào', body: 'Làm tiếp nhé', url: 'https://unlock.zuey.me/home', tag: 'daily-reminder' },
      { subject: 'mailto:test@example.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      fetchFn,
    );

    expect(status).toBe(201);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(sub.endpoint);
    expect(init.method).toBe('POST');
    expect(init.headers['content-encoding']).toBe('aes128gcm');
    expect(init.headers.ttl).toBe(String(4 * 3600));
    expect(init.headers.urgency).toBe('normal');
    expect(init.headers.topic).toBe('daily-reminder');

    const m = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.authorization);
    expect(m?.[2]).toBe(vapid.publicKey);
    const claims = await verifyVapidJwt(m![1], vapid.verifyKey);
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:test@example.com');

    const payload = JSON.parse(await decryptPushBody(init.body as Uint8Array<ArrayBuffer>, sub));
    expect(payload).toMatchObject({
      web_push: 8030,
      notification: { title: 'Xin chào', body: 'Làm tiếp nhé', navigate: 'https://unlock.zuey.me/home', tag: 'daily-reminder', lang: 'vi' },
    });
  });

  it('returns the push service status (e.g. 410 Gone) for the caller to act on', async () => {
    const vapid = await makeVapidKeys();
    const sub = await makeBrowserSubscription('https://web.push.apple.com/xyz');
    const status = await sendWebPush(sub, { title: 't', body: 'b', url: 'https://unlock.zuey.me/', tag: 't' },
      { subject: 'mailto:a@b.c', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      async () => new Response('gone', { status: 410 }));
    expect(status).toBe(410);
  });

  it('reports missing VAPID configuration as null', () => {
    expect(vapidFromEnv({ VAPID_SUBJECT: 'mailto:a@b.c' } as Env)).toBeNull();
    expect(vapidFromEnv({ VAPID_SUBJECT: 'mailto:a@b.c', VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'd' } as Env)).not.toBeNull();
  });
});
