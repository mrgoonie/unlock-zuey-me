/*
 * AI Unlocked service worker (scope /).
 * - Navigations: network first, offline fallback page when the network is down (pages are personal, never cached).
 * - /_astro/* (hashed build assets) and /icons/*: cache first.
 * - /api/* and everything else: network only (not intercepted).
 * - push: shows the reminder (Declarative Web Push shape {web_push: 8030, notification} or plain {title, body, url}).
 * - notificationclick: focuses/opens the target page and reports push.opened.
 */
const VERSION = 'v1';
const STATIC_CACHE = `static-${VERSION}`;
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-96.png';
const PRECACHE = [ICON, BADGE, '/icons/icon.svg'];

const OFFLINE_HTML = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Mất kết nối · AI Unlocked</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#fbf8f3;color:#1d1b18;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center}
@media (prefers-color-scheme:dark){body{background:#16140f;color:#f2ede4}}
button{font:inherit;font-weight:600;min-height:44px;padding:0 20px;border:0;border-radius:12px;background:#e8592e;color:#fff;cursor:pointer}
p{max-width:28rem;line-height:1.5}</style></head>
<body><main><div style="font-size:48px" aria-hidden="true">📡</div><h1>Bạn đang ngoại tuyến</h1>
<p>Không sao cả, bài làm đã lưu vẫn được giữ. Khi có mạng trở lại, hãy tải lại trang để làm tiếp.</p>
<button type="button" onclick="location.reload()">Thử lại</button></main></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('static-') && k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const offlineResponse = () =>
  new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(offlineResponse));
    return;
  }
  if (url.pathname.startsWith('/_astro/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
  }
});

/** Normalizes both payload shapes into {title, options}. */
function parsePush(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const n = data && typeof data.notification === 'object' && data.notification ? data.notification : data;
  const url = n.navigate || n.url || data.url || '/home';
  return {
    title: n.title || 'AI Unlocked',
    options: {
      body: n.body || 'Ghé qua làm một bước nhỏ nhé.',
      icon: ICON,
      badge: BADGE,
      tag: n.tag || 'ai-unlocked',
      lang: n.lang || 'vi',
      data: { url, tag: n.tag || null },
    },
  };
}

self.addEventListener('push', (event) => {
  const { title, options } = parsePush(event);
  // Every push must show a notification (required by Safari/iOS and Chrome).
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Only same-origin targets may be opened from a notification. */
function safeTarget(raw) {
  try {
    const u = new URL(raw || '/home', self.location.origin);
    return u.origin === self.location.origin ? u.href : new URL('/home', self.location.origin).href;
  } catch {
    return new URL('/home', self.location.origin).href;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = safeTarget(data.url);
  const report = fetch('/api/v1/push/opened', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag: data.tag || undefined, url: target }),
  }).catch(() => undefined);

  const open = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (wins) => {
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      await w.focus();
      if ('navigate' in w) return w.navigate(target).catch(() => undefined);
      return undefined;
    }
    return self.clients.openWindow(target);
  });
  event.waitUntil(Promise.all([report, open]));
});
