import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { retryOnSocketReset } from './helpers/retry-socket-reset';

/**
 * ai-tutor insights (issue #25) against E2E_BASE_URL. Member flows cannot be automated here (they need a
 * zuey.me member session), so they are covered by tests/unit/insights-end-to-end-pipeline.test.ts and the
 * manual QA script in docs/insights-rollout.md.
 *
 * The mode under test is INSIGHTS_MODE from wrangler.jsonc (what the deploy ships); E2E_INSIGHTS=1 or 0 overrides
 * it for a preview started with another --var.
 * off: every insights surface is absent for everyone.
 * internal, pilot, on: a guest gets the sign-in CTA on /insights/pair, /skill serves a manifest whose sha256
 * hashes match the files actually served, and the member pages and APIs stay 404 for a guest.
 */
function deployedInsightsMode(): string {
  const m = /"INSIGHTS_MODE"\s*:\s*"([^"]*)"/.exec(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  return (m?.[1] ?? 'off').trim().toLowerCase();
}
const override = process.env.E2E_INSIGHTS;
const insightsOn = override === '1' || (override !== '0' && ['internal', 'pilot', 'on'].includes(deployedInsightsMode()));

/** Guests never see the Settings section, in either mode. */
test('Settings has no insights section for a guest', async ({ request }) => {
  const res = await retryOnSocketReset(() => request.get('/settings'));
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).not.toContain('id="s-insights"');
  expect(html).not.toContain('data-testid="insights-settings"');
});

test.describe('insights flag off', () => {
  test.skip(insightsOn, 'E2E_INSIGHTS=1 targets a preview with the feature on');

  // The default request context is a browser (Pixel 7), so it gets a guest session: then every path is a 404.
  for (const path of [
    '/skill', '/skill/manifest.json', '/skill/install.mjs', '/skill/files/SKILL.md',
    '/insights', '/insights/pair', '/admin/insights', '/admin/insights/proposals',
    '/api/v1/insights/settings', '/api/v1/insights/reports', '/api/v1/admin/insights/summary', '/api/v1/admin/insights/proposals',
  ]) {
    test(`GET ${path} is a 404`, async ({ request }) => {
      const res = await retryOnSocketReset(() => request.get(path));
      expect(res.status()).toBe(404);
    });
  }

  // Without any session (a non-browser client gets none), the middleware answers every /api/v1 path 401 before
  // routing, nonexistent ones included. The insights APIs must be indistinguishable from a path that does not exist.
  for (const [path, nonexistent] of [
    ['/api/v1/admin/insights/summary', '/api/v1/admin/khong-ton-tai'],
    ['/api/v1/admin/insights/proposals', '/api/v1/admin/khong-ton-tai'],
    ['/api/v1/insights/reports', '/api/v1/khong-ton-tai'],
  ]) {
    test(`without a session, GET ${path} answers like ${nonexistent}`, async ({ request }) => {
      const headers = { 'user-agent': 'curl/8.0' };
      const real = await retryOnSocketReset(() => request.get(path, { headers }));
      const absent = await retryOnSocketReset(() => request.get(nonexistent, { headers }));
      expect(real.status()).toBe(absent.status());
      expect([401, 404]).toContain(real.status());
    });
  }

  test('ingest answers 404 feature_off before looking at the token or body', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.post('/api/ingest/v1/turns', {
      headers: { 'content-type': 'application/json', authorization: `Bearer aiu_ing_${'A'.repeat(43)}` },
      data: {},
    }));
    expect(res.status()).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found', reason: 'feature_off' } });
  });

  test('the progress page has no link to the insights reports', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.get('/progress'));
    expect(res.status()).toBe(200);
    expect(await res.text()).not.toContain('href="/insights"');
  });
});

test.describe('insights flag on', () => {
  test.skip(!insightsOn, 'INSIGHTS_MODE is off (set E2E_INSIGHTS=1 against a preview running with the feature on)');

  test('a guest on /insights/pair gets the zuey.me sign-in CTA that returns with the code', async ({ page }) => {
    await page.goto('/insights/pair?code=ABCD-EFGH');
    const cta = page.getByRole('link', { name: 'Đăng nhập với zuey.me' });
    await expect(cta).toBeVisible();
    const href = new URL((await cta.getAttribute('href')) ?? '', page.url());
    expect(href.pathname).toBe('/auth/zuey/login');
    expect(href.searchParams.get('return_to')).toBe('/insights/pair?code=ABCD-EFGH');
    await expect(page.getByTestId('pair-device')).toHaveCount(0);
  });

  for (const path of ['/insights', '/admin/insights', '/admin/insights/proposals', '/api/v1/insights/reports', '/api/v1/admin/insights/summary']) {
    test(`GET ${path} stays a 404 for a guest`, async ({ request }) => {
      const res = await retryOnSocketReset(() => request.get(path));
      expect(res.status()).toBe(404);
    });
  }

  test('ingest rejects an unknown device token', async ({ request }) => {
    const res = await retryOnSocketReset(() => request.post('/api/ingest/v1/turns', {
      headers: { 'content-type': 'application/json', authorization: `Bearer aiu_ing_${'A'.repeat(43)}` },
      data: {},
    }));
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  test('/skill serves a manifest whose file hashes verify', async ({ request }) => {
    const page = await retryOnSocketReset(() => request.get('/skill'));
    expect(page.status()).toBe(200);
    expect(await page.text()).toContain('/skill/install.mjs | node - --scope user');

    const res = await retryOnSocketReset(() => request.get('/skill/manifest.json'));
    expect(res.status()).toBe(200);
    const manifest = (await res.json()) as { name: string; version: string; files: Array<{ path: string; sha256: string; bytes: number }> };
    expect(manifest.name).toBe('ai-unlocked');
    expect(manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining(['SKILL.md', 'manifest.json', 'scripts/install.mjs', 'scripts/stop-hook.mjs']));
    for (const file of manifest.files) {
      const url = `/skill/files/${file.path.split('/').map(encodeURIComponent).join('/')}`;
      const got = await retryOnSocketReset(() => request.get(url));
      expect(got.status(), url).toBe(200);
      const body = await got.body();
      expect(body.byteLength, url).toBe(file.bytes);
      expect(createHash('sha256').update(body).digest('hex'), url).toBe(file.sha256);
    }

    const installer = manifest.files.find((f) => f.path === 'scripts/install.mjs');
    const bootstrap = await retryOnSocketReset(() => request.get('/skill/install.mjs'));
    expect(createHash('sha256').update(await bootstrap.body()).digest('hex')).toBe(installer?.sha256);
  });
});
