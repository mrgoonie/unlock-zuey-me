/**
 * Dashboard gating and copy. Astro pages are not rendered in unit tests (no Astro container in the vitest
 * config), so page gating is asserted through insightsEnabledFor plus a structural check of each page source,
 * and the islands' pure helpers are tested directly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insightsEnabledFor } from '../../src/lib/insights/feature-flags';
import { collectionStatus } from '../../src/components/settings/InsightsSettingsPanel';
import { normalizeCode } from '../../src/components/insights/PairApproval';
import { rangeFrom } from '../../src/components/insights/InsightFilters';
import { confidenceLabel, OBSERVABLE_ONLY_DISCLAIMER, provenanceLine } from '../../src/components/insights/insights-api';
import { normalizeUserCode } from '../../src/lib/insights/ingest-contract';
import { learnerCtx } from './observer-seed-fixtures';

const src = (path: string) => readFileSync(join(__dirname, '../../src', path), 'utf8');
const member = learnerCtx('lrn_m');
const admin = learnerCtx('lrn_admin', { isAdmin: true });

describe('feature gate used by every insights page, section and link', () => {
  it('is off for everyone while INSIGHTS_MODE is off, unset or unknown', () => {
    for (const mode of [undefined, '', 'off', 'yes']) {
      expect(insightsEnabledFor({ INSIGHTS_MODE: mode }, member)).toBe(false);
      expect(insightsEnabledFor({ INSIGHTS_MODE: mode }, admin)).toBe(false);
    }
  });

  it('internal → admins only; on → members; guests never', () => {
    expect(insightsEnabledFor({ INSIGHTS_MODE: 'internal' }, admin)).toBe(true);
    expect(insightsEnabledFor({ INSIGHTS_MODE: 'internal' }, member)).toBe(false);
    expect(insightsEnabledFor({ INSIGHTS_MODE: 'on' }, member)).toBe(true);
    expect(insightsEnabledFor({ INSIGHTS_MODE: 'on' }, learnerCtx('lrn_g', { kind: 'guest' }))).toBe(false);
  });
});

describe('pages render insights UI only behind the gate', () => {
  it('settings renders the insights section only inside the insightsEnabled condition', () => {
    const page = src('pages/settings.astro');
    expect(page).toContain('const insightsEnabled = insightsEnabledFor(Astro.locals.runtime.env, learner);');
    const gated = page.slice(page.indexOf('{insightsEnabled && ('));
    expect(gated.indexOf('<InsightsSettingsPanel')).toBeGreaterThan(0);
    expect(gated.indexOf('<InsightsSettingsPanel')).toBeLessThan(gated.indexOf(')}'));
    expect(page.match(/<InsightsSettingsPanel/g)).toHaveLength(1);
    expect(page.indexOf('s-insights')).toBeGreaterThan(page.indexOf('{insightsEnabled && ('));
  });

  it('progress and admin links to insights appear only when enabled, and existing links stay', () => {
    const progress = src('pages/progress.astro');
    expect(progress).toMatch(/\{insightsEnabled \? \(\s*<div[^>]*>\s*<a href="\/insights"/);
    expect(progress.match(/href="\/insights"/g)).toHaveLength(1);
    expect(progress.match(/🏅 Thành tích/g)).toHaveLength(2); // same link in both branches
    const adminIndex = src('pages/admin/index.astro');
    expect(adminIndex).toContain('{insightsEnabled && <a href="/admin/insights"');
  });

  it('every insights page sets 404 unless the gate passes', () => {
    for (const page of ['pages/insights.astro', 'pages/insights/pair.astro', 'pages/admin/insights/index.astro', 'pages/admin/insights/learners/[id].astro']) {
      const s = src(page);
      expect(s, page).toContain('insightsEnabledFor(');
      expect(s, page).toContain('Astro.response.status = 404');
    }
  });
});

describe('copy never claims access to hidden reasoning', () => {
  it('shows the fixed observable-only disclaimer on the learner page and drill-down', () => {
    expect(OBSERVABLE_ONLY_DISCLAIMER).toBe(
      'ai-tutor chỉ dựa trên những gì hiển thị trong phiên (lời nhắn của bạn, câu trả lời cuối, tên công cụ đã dùng). Nó không đọc được suy luận ẩn của mô hình AI.',
    );
    expect(src('pages/insights.astro')).toContain('OBSERVABLE_ONLY_DISCLAIMER');
    expect(src('pages/admin/insights/learners/[id].astro')).toContain('OBSERVABLE_ONLY_DISCLAIMER');
  });

  it('no insights UI file claims to read the model’s thoughts', () => {
    const files = [
      'components/insights/InsightReportCard.tsx', 'components/insights/InsightsTimeline.tsx', 'components/insights/PairApproval.tsx',
      'components/insights/insights-api.ts', 'components/settings/InsightsSettingsPanel.tsx', 'pages/insights.astro',
      'components/admin/insights/drilldown/OperatorReportList.astro',
    ];
    const forbidden = [/chain[- ]of[- ]thought/i, /AI (đã )?nghĩ/i, /suy nghĩ của (AI|mô hình)/i, /đọc được suy luận(?! ẩn của mô hình AI\.)/i];
    for (const f of files) for (const re of forbidden) expect(src(f), `${f} ${re}`).not.toMatch(re);
  });

  it('provenance line names the source, the server-side analyzer, turn count and model', () => {
    const line = provenanceLine({ sourceRuntime: 'claude-code', model: 'flash-lite', promptVersion: 1, eventCount: 4, windowStartedAt: '', windowEndedAt: '' });
    expect(line).toBe('Nguồn: Claude Code · phân tích bởi ai-tutor (máy chủ) · dựa trên 4 lượt · mô hình flash-lite');
    expect(confidenceLabel(0.756)).toBe('độ tin cậy 76%');
    expect(confidenceLabel(7)).toBe('độ tin cậy 100%');
  });
});

describe('island helpers', () => {
  it('settings status chip', () => {
    const now = new Date('2026-10-26T00:00:00.000Z');
    const device = { id: 'itk_1', label: 'Mac', adapter: 'claude-code', createdAt: '', lastUsedAt: null, expiresAt: '2027-01-01T00:00:00.000Z' };
    const consents = (analysis: boolean) => ({ analysis, shareOperator: false, proposals: false });
    expect(collectionStatus({ consents: consents(false), devices: [device] }, now).label).toBe('Đã tạm dừng');
    expect(collectionStatus({ consents: consents(true), devices: [] }, now).label).toBe('Chưa kết nối thiết bị');
    expect(collectionStatus({ consents: consents(true), devices: [{ ...device, expiresAt: '2026-01-01T00:00:00.000Z' }] }, now).label).toBe('Chưa kết nối thiết bị');
    expect(collectionStatus({ consents: consents(true), devices: [device] }, now).label).toBe('Đang thu thập');
  });

  it('pair code normalisation matches the contract helper', () => {
    for (const input of ['abcd-efgh', 'ABCDEFGH', ' abcd efgh ', 'ABCD-EFG', 'ABCD-EFG1', 'ABCD-EFGI', '']) {
      expect(normalizeCode(input), input).toBe(normalizeUserCode(input));
    }
  });

  it('time range presets', () => {
    const now = new Date('2026-10-26T00:00:00.000Z');
    expect(rangeFrom('', now)).toBeNull();
    expect(rangeFrom('7', now)).toBe('2026-10-19T00:00:00.000Z');
    expect(rangeFrom('abc', now)).toBeNull();
  });
});
