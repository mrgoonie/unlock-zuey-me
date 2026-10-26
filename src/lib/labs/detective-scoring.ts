/**
 * Hallucination-detective scoring. Each claim has one or more accepted verdicts (the first is the
 * "best" answer shown in the explanation); red flags are the surface patterns that should trigger a check.
 */
export type ClaimVerdict = 'verified' | 'needs_lookup' | 'insufficient' | 'expert';
export type RedFlag = 'number' | 'citation' | 'recent' | 'url';

export interface Claim {
  id: string;
  text: string;
  /** Verdicts that earn the point; the first one is the recommended verdict. */
  accepted: [ClaimVerdict, ...ClaimVerdict[]];
  explain: string;
  flags: RedFlag[];
}

export const VERDICTS: ReadonlyArray<{ id: ClaimVerdict; label: string; emoji: string; hint: string }> = [
  { id: 'verified', label: 'Tin được', emoji: '✅', hint: 'Kiến thức phổ biến, ít thay đổi' },
  { id: 'needs_lookup', label: 'Cần tra lại', emoji: '🔎', hint: 'Con số, giờ giấc, giá, link, tin mới' },
  { id: 'insufficient', label: 'Thiếu thông tin', emoji: '🤷', hint: 'AI không thể biết từ những gì bạn kể' },
  { id: 'expert', label: 'Hỏi chuyên gia', emoji: '🩺', hint: 'Sức khoẻ, pháp lý, tài chính cá nhân' },
];

export const RED_FLAGS: Readonly<Record<RedFlag, { label: string; emoji: string; tip: string }>> = {
  number: { label: 'Con số quá cụ thể', emoji: '🔢', tip: 'Giá, giờ, phần trăm càng chính xác càng phải tra lại.' },
  citation: { label: 'Trích dẫn nghiên cứu, nguồn', emoji: '📚', tip: 'Nguồn có thể bị bịa, hoặc không nói điều đó.' },
  recent: { label: 'Tin mới, sự kiện gần đây', emoji: '🗞️', tip: 'AI có mốc kiến thức, chuyện mới dễ sai.' },
  url: { label: 'Đường link', emoji: '🔗', tip: 'Link AI đưa có thể không tồn tại. Hãy bấm thử.' },
};

export const isVerdictCorrect = (claim: Claim, verdict: ClaimVerdict): boolean => claim.accepted.includes(verdict);

/** Score = number of claims answered with an accepted verdict; unanswered claims score 0. */
export function scoreVerdicts(
  claims: readonly Claim[],
  answers: Readonly<Record<string, ClaimVerdict | undefined>>,
): { score: number; total: number } {
  const score = claims.filter((c) => {
    const v = answers[c.id];
    return v !== undefined && isVerdictCorrect(c, v);
  }).length;
  return { score, total: claims.length };
}

/** How many times each red flag appeared, most frequent first (flags that never appeared are omitted). */
export function tallyRedFlags(claims: readonly Claim[]): Array<{ flag: RedFlag; count: number }> {
  const counts = new Map<RedFlag, number>();
  for (const c of claims) for (const f of c.flags) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts.entries()].map(([flag, count]) => ({ flag, count })).sort((a, b) => b.count - a.count);
}
