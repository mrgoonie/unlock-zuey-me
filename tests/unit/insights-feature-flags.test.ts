/** Insights feature flags: mode matrix, GitHub mode forced off without a token, numeric var parsing. */
import { describe, expect, it } from 'vitest';
import {
  dailyAnalysesGlobal, dailyAnalysesPerLearner, DEFAULT_GITHUB_REPO, githubIssuesMode, githubIssuesRepo, insightsEnabledFor,
  insightsMode, insightsRetentionDays, pilotEmails, positiveIntVar,
} from '../../src/lib/insights/feature-flags';
import { learnerCtx } from './observer-seed-fixtures';

const member = learnerCtx('lrn_m');
const admin = learnerCtx('lrn_admin', { isAdmin: true });
const pilot = learnerCtx('lrn_p', { email: 'Pilot@Example.com' });
const guest = learnerCtx('lrn_g', { kind: 'guest', email: null });
const guestAdminFlag = learnerCtx('lrn_ga', { kind: 'guest', isAdmin: true });

describe('insightsMode', () => {
  it('defaults to off when unset, empty or unknown', () => {
    expect(insightsMode({})).toBe('off');
    expect(insightsMode({ INSIGHTS_MODE: '' })).toBe('off');
    expect(insightsMode({ INSIGHTS_MODE: 'yes' })).toBe('off');
    expect(insightsMode({ INSIGHTS_MODE: 'true' })).toBe('off');
  });

  it('accepts the four modes, trimmed and case-insensitive', () => {
    expect(insightsMode({ INSIGHTS_MODE: 'off' })).toBe('off');
    expect(insightsMode({ INSIGHTS_MODE: ' Internal ' })).toBe('internal');
    expect(insightsMode({ INSIGHTS_MODE: 'PILOT' })).toBe('pilot');
    expect(insightsMode({ INSIGHTS_MODE: 'on' })).toBe('on');
  });
});

describe('insightsEnabledFor', () => {
  const matrix: Array<[string | undefined, Record<string, boolean>]> = [
    [undefined, { member: false, admin: false, pilot: false, guest: false, guestAdminFlag: false }],
    ['off', { member: false, admin: false, pilot: false, guest: false, guestAdminFlag: false }],
    ['internal', { member: false, admin: true, pilot: false, guest: false, guestAdminFlag: false }],
    ['pilot', { member: false, admin: true, pilot: true, guest: false, guestAdminFlag: false }],
    ['on', { member: true, admin: true, pilot: true, guest: false, guestAdminFlag: false }],
  ];
  const learners = { member, admin, pilot, guest, guestAdminFlag };
  for (const [mode, expected] of matrix) {
    it(`mode ${mode ?? '(unset)'}`, () => {
      const env = { INSIGHTS_MODE: mode, INSIGHTS_PILOT_EMAILS: 'someone@x.vn, pilot@example.com' };
      const got = Object.fromEntries(Object.entries(learners).map(([k, l]) => [k, insightsEnabledFor(env, l)]));
      expect(got).toEqual(expected);
    });
  }

  it('is false without a learner', () => {
    expect(insightsEnabledFor({ INSIGHTS_MODE: 'on' }, undefined)).toBe(false);
    expect(insightsEnabledFor({ INSIGHTS_MODE: 'on' }, null)).toBe(false);
  });

  it('pilot needs an email on the list; a member without email is excluded', () => {
    const env = { INSIGHTS_MODE: 'pilot', INSIGHTS_PILOT_EMAILS: '' };
    expect(insightsEnabledFor(env, pilot)).toBe(false);
    expect(insightsEnabledFor({ ...env, INSIGHTS_PILOT_EMAILS: 'pilot@example.com' }, learnerCtx('x', { email: null }))).toBe(false);
  });

  it('parses pilot emails separated by commas or whitespace', () => {
    expect([...pilotEmails({ INSIGHTS_PILOT_EMAILS: ' A@x.vn,b@y.vn\nc@z.vn  ,, ' })]).toEqual(['a@x.vn', 'b@y.vn', 'c@z.vn']);
    expect(pilotEmails({}).size).toBe(0);
  });
});

describe('githubIssuesMode', () => {
  const on = { INSIGHTS_MODE: 'on', GITHUB_ISSUES_TOKEN: 'github_pat_x' };

  it('is off without a token, whatever the var says', () => {
    for (const v of ['issues', 'issues_ai_handle', 'off', undefined]) {
      expect(githubIssuesMode({ INSIGHTS_MODE: 'on', INSIGHTS_GITHUB_ISSUES: v })).toBe('off');
      expect(githubIssuesMode({ INSIGHTS_MODE: 'on', INSIGHTS_GITHUB_ISSUES: v, GITHUB_ISSUES_TOKEN: '  ' })).toBe('off');
    }
  });

  it('is off while the insights feature is off, even with a token', () => {
    expect(githubIssuesMode({ ...on, INSIGHTS_MODE: 'off', INSIGHTS_GITHUB_ISSUES: 'issues_ai_handle' })).toBe('off');
    expect(githubIssuesMode({ GITHUB_ISSUES_TOKEN: 't', INSIGHTS_GITHUB_ISSUES: 'issues' })).toBe('off');
  });

  it('follows the var with a token, unknown values being off', () => {
    expect(githubIssuesMode({ ...on, INSIGHTS_GITHUB_ISSUES: 'issues' })).toBe('issues');
    expect(githubIssuesMode({ ...on, INSIGHTS_GITHUB_ISSUES: 'Issues_AI_Handle' })).toBe('issues_ai_handle');
    expect(githubIssuesMode({ ...on, INSIGHTS_GITHUB_ISSUES: 'all' })).toBe('off');
    expect(githubIssuesMode({ ...on })).toBe('off');
  });

  it('validates the repository', () => {
    expect(githubIssuesRepo({})).toBe(DEFAULT_GITHUB_REPO);
    expect(githubIssuesRepo({ INSIGHTS_GITHUB_REPO: 'owner/repo.js' })).toBe('owner/repo.js');
    expect(githubIssuesRepo({ INSIGHTS_GITHUB_REPO: 'https://github.com/a/b' })).toBe(DEFAULT_GITHUB_REPO);
    expect(githubIssuesRepo({ INSIGHTS_GITHUB_REPO: 'a/b/c' })).toBe(DEFAULT_GITHUB_REPO);
  });
});

describe('numeric vars', () => {
  it('positiveIntVar accepts integers in [1, max] only', () => {
    expect(positiveIntVar('5', 9, 10)).toBe(5);
    expect(positiveIntVar(' 10 ', 9, 10)).toBe(10);
    for (const bad of [undefined, '', '0', '-1', '1.5', '11', 'abc', '1e3']) expect(positiveIntVar(bad, 9, 10), String(bad)).toBe(9);
  });

  it('uses the documented defaults', () => {
    expect(insightsRetentionDays({})).toBe(90);
    expect(dailyAnalysesPerLearner({})).toBe(12);
    expect(dailyAnalysesGlobal({})).toBe(200);
    expect(insightsRetentionDays({ INSIGHTS_RETENTION_DAYS: '30' })).toBe(30);
    expect(dailyAnalysesPerLearner({ INSIGHTS_DAILY_ANALYSES_PER_LEARNER: '0' })).toBe(12);
    expect(dailyAnalysesGlobal({ INSIGHTS_DAILY_ANALYSES_GLOBAL: '500' })).toBe(500);
  });
});
