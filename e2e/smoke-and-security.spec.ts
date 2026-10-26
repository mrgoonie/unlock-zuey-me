import { expect, test } from '@playwright/test';
import { retryOnSocketReset } from './helpers/retry-socket-reset';

/**
 * Production smoke and security checks. Mostly plain HTTP, with two browser checks for keyboard focus and
 * reduced motion. Nothing here creates AI grading calls.
 */

const PUBLIC_PAGES = [
  '/',
  '/home',
  '/missions',
  '/labs',
  '/labs/token-predictor',
  '/concepts',
  '/concepts/token',
  '/settings',
  '/progress',
  '/achievements',
];

const SITE = 'https://unlock.zuey.me';
const MCP_RESOURCE = `${SITE}/mcp`;

test.describe('key pages respond 200', () => {
  for (const path of PUBLIC_PAGES) {
    test(`GET ${path}`, async ({ request }) => {
      const res = await retryOnSocketReset(() => request.get(path));
      expect(res.status()).toBe(200);
    });
  }
});

test.describe('admin surfaces hide from guests', () => {
  test('/admin is a 404 for a guest', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.get('/admin'));
    expect(res.status()).toBe(404);
  });

  test('/api/v1/admin/learners is a 404 for a guest', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.get('/api/v1/admin/learners'));
    expect(res.status()).toBe(404);
  });
});

test.describe('same-origin protection', () => {
  for (const method of ['post', 'patch'] as const) {
    test(`${method.toUpperCase()} /api/v1/me/consent from a foreign Origin is 403`, async ({ request }) => {
      const res = await retryOnSocketReset(() => request[method]('/api/v1/me/consent', {
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        data: { observer: true },
      }));
      expect(res.status()).toBe(403);
    });
  }
});

test.describe('MCP and OAuth discovery', () => {
  test('POST /mcp without a token is 401 and points at the protected resource metadata', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.post('/mcp', {
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    }));
    expect(res.status()).toBe(401);
    expect(res.headers()['www-authenticate']).toContain('resource_metadata');
  });

  test('protected resource metadata names the MCP resource', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.get('/.well-known/oauth-protected-resource/mcp'));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { resource?: string };
    expect(body.resource).toBe(MCP_RESOURCE);
  });

  test('client metadata document has the expected CIMD shape', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.get('/oauth/zuey-client.json'));
    expect(res.status()).toBe(200);
    const doc = (await res.json()) as {
      client_id: string;
      redirect_uris: string[];
      token_endpoint_auth_method: string;
      scope: string;
      grant_types: string[];
      response_types: string[];
    };
    expect(doc.client_id).toBe(`${SITE}/oauth/zuey-client.json`);
    expect(doc.redirect_uris).toEqual([`${SITE}/auth/zuey/callback`]);
    expect(doc.token_endpoint_auth_method).toBe('none');
    expect(doc.response_types).toContain('code');
    expect(doc.grant_types).toContain('authorization_code');
    expect(doc.scope.split(' ')).toContain('openid');
  });

  test('sign in with zuey.me redirects to the zuey.me authorize endpoint with PKCE', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.get('/auth/zuey/login?return_to=/home', { maxRedirects: 0 }));
    expect([302, 303]).toContain(res.status());
    const location = new URL(res.headers().location);
    expect(`${location.origin}${location.pathname}`).toBe('https://zuey.me/oauth/authorize');
    expect(location.searchParams.get('scope')?.split(' ')).toContain('openid');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

test.describe('PWA assets', () => {
  test('manifest.webmanifest is valid JSON with install fields', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.get('/manifest.webmanifest'));
    expect(res.status()).toBe(200);
    const manifest = (await res.json()) as {
      name: string;
      start_url: string;
      display: string;
      icons: Array<{ src: string }>;
    };
    expect(manifest.name).toBe('AI Unlocked');
    expect(manifest.start_url).toBe('/home');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  test('sw.js is served as JavaScript', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.get('/sw.js'));
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('javascript');
  });
});

test.describe('keyboard and motion in the browser', () => {
  test('the mission start control is reachable by Tab and gets a visible focus ring', async ({ page }) => {
    await page.goto('/missions/plan-weekend');
    const start = page.getByTestId('mission-start');
    await expect(start).toBeVisible();

    const style = () => start.evaluate((el) => {
      const s = getComputedStyle(el);
      return { boxShadow: s.boxShadow, outlineStyle: s.outlineStyle };
    });
    const before = await style();

    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await start.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(start).toBeFocused();
    expect(await start.evaluate((el) => el.matches(':focus-visible'))).toBe(true);

    const after = await style();
    const ringVisible = after.outlineStyle !== 'none' || after.boxShadow !== before.boxShadow;
    expect(ringVisible, `focus styles unchanged: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toBe(true);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  // Best effort: flags any CSS animation that still runs longer than 10 ms on these pages.
  for (const path of ['/home', '/missions']) {
    test(`no long-running CSS animations on ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const running = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => a instanceof CSSAnimation && a.playState === 'running')
          .map((a) => ({ name: (a as CSSAnimation).animationName, duration: Number(a.effect?.getComputedTiming().duration) }))
          .filter((a) => a.duration > 10),
      );
      expect(running).toEqual([]);
    });
  }
});
