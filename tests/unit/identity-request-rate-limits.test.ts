import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { resolveRequestLearner } from '../../src/lib/identity/request-learner';
import {
  allowByLimiter, clientIpKey, LIMITER_RULES, resetFallbackLimiter, throttledRoute, type LimiterName,
} from '../../src/lib/identity/request-rate-limits';

const T0 = new Date('2026-10-26T03:00:00Z').getTime();
const withIp = (ip?: string) => new Request('https://unlock.zuey.me/api/v1/coach/chat', { headers: ip ? { 'cf-connecting-ip': ip } : {} });

beforeEach(() => resetFallbackLimiter());

describe('throttled routes', () => {
  it('maps the AI, upload and row-writing POST endpoints to their limiters', () => {
    expect(throttledRoute('/api/v1/coach/chat', 'POST')).toMatchObject({ scope: 'chat', ipLimiter: 'RL_AI_IP' });
    expect(throttledRoute('/api/v1/runs/run_1/hints', 'POST')).toMatchObject({ scope: 'hint', ipLimiter: 'RL_AI_IP' });
    expect(throttledRoute('/api/v1/runs/run_1/submit/', 'POST')).toMatchObject({ scope: 'submit', ipLimiter: 'RL_AI_IP' });
    expect(throttledRoute('/api/v1/evidence/upload', 'POST')).toMatchObject({ scope: 'upload', ipLimiter: 'RL_AI_IP' });
    for (const [path, scope] of [
      ['/api/v1/events', 'event'], ['/api/v1/labs/context-lab/result', 'lab'],
      ['/api/v1/missions/plan-weekend/start', 'start'], ['/api/v1/runs/run_1/abandon', 'abandon'], ['/api/v1/push/subscribe', 'push'],
    ]) {
      expect(throttledRoute(path, 'POST')).toEqual({ scope, ipLimiter: 'RL_WRITE_IP', learnerLimiter: 'RL_WRITE_LEARNER' });
    }
  });

  it('leaves reads and other endpoints alone', () => {
    expect(throttledRoute('/api/v1/coach/chat', 'GET')).toBeNull();
    expect(throttledRoute('/api/v1/runs/run_1', 'POST')).toBeNull();
    expect(throttledRoute('/api/v1/runs/run_1/answers', 'POST')).toBeNull();
    expect(throttledRoute('/api/v1/me/export', 'GET')).toBeNull();
  });
});

describe('client IP key', () => {
  it('uses CF-Connecting-IP and groups IPv6 clients by /64', () => {
    expect(clientIpKey(withIp('203.0.113.7'))).toBe('ip:203.0.113.7');
    expect(clientIpKey(withIp('2001:db8:aa:bb:1:2:3:4'))).toBe('ip6:2001:db8:aa:bb::/64');
    expect(clientIpKey(withIp('2001:db8:aa:bb::9'))).toBe('ip6:2001:db8:aa:bb::/64');
    expect(clientIpKey(withIp('2001:0DB8:00aa:00bb::ffff'))).toBe('ip6:2001:db8:aa:bb::/64');
    expect(clientIpKey(withIp('::ffff:192.0.2.1'))).toBe('ip:192.0.2.1');
    expect(clientIpKey(withIp('64:ff9b::192.0.2.1'))).toBe('ip6:64:ff9b:0:0::/64');
    expect(clientIpKey(withIp())).toBe('ip:unknown');
  });
});

describe('allowByLimiter', () => {
  it('falls back to an in-memory fixed window with the configured limit when the binding is absent', async () => {
    const { limit } = LIMITER_RULES.RL_GUEST_IP;
    for (let i = 0; i < limit; i++) expect(await allowByLimiter({}, 'RL_GUEST_IP', 'ip:1.2.3.4', T0)).toBe(true);
    expect(await allowByLimiter({}, 'RL_GUEST_IP', 'ip:1.2.3.4', T0)).toBe(false);
    // Other IPs and other limiters are counted separately; the next window starts fresh.
    expect(await allowByLimiter({}, 'RL_GUEST_IP', 'ip:5.6.7.8', T0)).toBe(true);
    expect(await allowByLimiter({}, 'RL_AI_IP', 'ip:1.2.3.4', T0)).toBe(true);
    expect(await allowByLimiter({}, 'RL_GUEST_IP', 'ip:1.2.3.4', T0 + 60_000)).toBe(true);
  });

  it('uses the binding when present and fails open when it throws', async () => {
    const limitFn = vi.fn(async ({ key }: { key: string }) => ({ success: key !== 'blocked' }));
    const env = { RL_AI_IP: { limit: limitFn } as unknown as RateLimit };
    expect(await allowByLimiter(env, 'RL_AI_IP', 'chat:ip:1.1.1.1')).toBe(true);
    expect(await allowByLimiter(env, 'RL_AI_IP', 'blocked')).toBe(false);
    expect(limitFn).toHaveBeenCalledWith({ key: 'chat:ip:1.1.1.1' });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { RL_AI_IP: { limit: vi.fn(async () => { throw new Error('down'); }) } as unknown as RateLimit };
    expect(await allowByLimiter(broken, 'RL_AI_IP', 'k')).toBe(true);
  });

  it('matches the ratelimits bindings declared in wrangler.jsonc', () => {
    const config = readFileSync(join(__dirname, '..', '..', 'wrangler.jsonc'), 'utf8');
    for (const [name, rule] of Object.entries(LIMITER_RULES) as Array<[LimiterName, (typeof LIMITER_RULES)[LimiterName]]>) {
      const re = new RegExp(`"name":\\s*"${name}",\\s*"namespace_id":\\s*"\\d+",\\s*"simple":\\s*\\{\\s*"limit":\\s*(\\d+),\\s*"period":\\s*(\\d+)`);
      const m = re.exec(config);
      expect(m, name).not.toBeNull();
      expect([Number(m![1]), Number(m![2])], name).toEqual([rule.limit, rule.periodSeconds]);
    }
  });
});

describe('guest creation per IP', () => {
  it('stops creating guests once the IP limit is reached, without touching the database', async () => {
    const env = { DB: createTestD1(), ADMIN_EMAILS: '' };
    const allowGuestCreation = () => allowByLimiter({}, 'RL_GUEST_IP', 'ip:9.9.9.9', T0);
    for (let i = 0; i < LIMITER_RULES.RL_GUEST_IP.limit; i++) {
      const r = await resolveRequestLearner(env, { token: undefined, policy: 'create', now: new Date(T0), allowGuestCreation });
      expect(r.learner?.kind).toBe('guest');
    }
    const blocked = await resolveRequestLearner(env, { token: undefined, policy: 'create', now: new Date(T0), allowGuestCreation });
    expect(blocked).toEqual({ learner: null, setCookieToken: null, clearCookie: false, guestThrottled: true });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM learners').first<{ n: number }>();
    expect(n?.n).toBe(LIMITER_RULES.RL_GUEST_IP.limit);
  });

  it('never consults the limiter for an existing session', async () => {
    const env = { DB: createTestD1(), ADMIN_EMAILS: '' };
    const created = await resolveRequestLearner(env, { token: undefined, policy: 'create', now: new Date(T0) });
    const allowGuestCreation = vi.fn(async () => false);
    const again = await resolveRequestLearner(env, { token: created.setCookieToken!, policy: 'create', now: new Date(T0), allowGuestCreation });
    expect(again.learner?.id).toBe(created.learner?.id);
    expect(allowGuestCreation).not.toHaveBeenCalled();
  });
});
