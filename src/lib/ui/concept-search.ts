/** Buzzword decoder search: accent-insensitive Vietnamese/English matching, group filter, review-due check. */
import type { Concept } from '../content/schema';

/** Lowercases and strips Vietnamese diacritics (đ → d) so "ao giac" matches "ảo giác". */
export const normalizeVi = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim();

export function filterConcepts(concepts: Concept[], query: string, group: Concept['group'] | null): Concept[] {
  const terms = normalizeVi(query).split(/\s+/).filter(Boolean);
  return concepts
    .filter((c) => !group || c.group === group)
    .map((c) => {
      const title = normalizeVi(`${c.label_vi} ${c.label_en} ${c.id}`);
      const body = normalizeVi(`${c.one_liner} ${c.beginner_explanation}`);
      if (!terms.every((t) => title.includes(t) || body.includes(t))) return null;
      const rank = terms.length ? terms.filter((t) => title.includes(t)).length : 0;
      return { c, rank };
    })
    .filter((x): x is { c: Concept; rank: number } => x !== null)
    .sort((a, b) => b.rank - a.rank || a.c.label_vi.localeCompare(b.c.label_vi, 'vi'))
    .map((x) => x.c);
}

/** True when a dated fact is past its review date ("cần kiểm tra lại"). `today` is YYYY-MM-DD. */
export const isReviewDue = (c: Pick<Concept, 'review_due_at'>, today: string): boolean =>
  !!c.review_due_at && c.review_due_at < today;

export const todayIso = (d = new Date()): string => d.toISOString().slice(0, 10);
