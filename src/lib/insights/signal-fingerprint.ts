/**
 * Semantic fingerprint of a product signal. Two observations that describe the same problem with
 * paraphrased topic keys ("hint unclear step" / "Step hint unclear") normalise to the same topic and so
 * land on the same `insight_signals` row, which is what makes proposal and issue dedupe work.
 *
 * The fingerprint is versioned (`v1|…`) so a future change of the normalisation can never silently merge
 * old and new signals.
 */
import { INSIGHT_FIXED_AREAS, type InsightArea, type ProposalCategory } from './insight-types';

/** Longest normalised topic key, cut at a token boundary. */
export const TOPIC_KEY_MAX = 48;

/** English and Vietnamese (diacritics stripped) filler words that never distinguish two topics. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'be', 'and', 'or', 'with', 'at', 'by',
  'it', 'its', 'this', 'that', 'from', 'as', 'into', 'about',
  'cua', 'va', 'la', 'cho', 'trong', 'mot', 'cac', 'nhung', 'thi', 'bi', 'duoc', 'voi', 'nay', 'khi', 've', 'o',
]);

/** Lower-cases and strips Vietnamese diacritics (đ → d) so accented and unaccented spellings match. */
export function foldVietnamese(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
}

/**
 * Normalised topic: lower case, no diacritics, stopwords dropped, tokens de-duplicated and sorted, joined
 * with `-`, at most 48 characters. Idempotent. An input with no meaningful token becomes `general`.
 */
export function normalizeTopicKey(s: string): string {
  const tokens = [...new Set(foldVietnamese(s.slice(0, 512)).split(/[^a-z0-9]+/).filter((t) => t && !STOPWORDS.has(t)))].sort();
  let out = '';
  for (const t of tokens) {
    const next = out ? `${out}-${t}` : t;
    if (next.length > TOPIC_KEY_MAX) break;
    out = next;
  }
  return out || 'general';
}

const MISSION_AREA = /^mission:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Controlled area: one of the fixed areas or `mission:<kebab-id>`; anything else becomes `other`. */
export function normalizeArea(area: string): InsightArea {
  const a = area.trim().toLowerCase();
  if ((INSIGHT_FIXED_AREAS as readonly string[]).includes(a)) return a as InsightArea;
  return MISSION_AREA.test(a) && a.length <= 80 ? (a as InsightArea) : 'other';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 hex of `v1|category|area|normalisedTopic`. Area and topic are normalised here as well. */
export function fingerprint(category: ProposalCategory, area: string, topicKey: string): Promise<string> {
  return sha256Hex(`v1|${category}|${normalizeArea(area)}|${normalizeTopicKey(topicKey)}`);
}

/** Readable, de-identified signal title built only from controlled fields (never from learner text). */
export function signalTitle(category: ProposalCategory, area: string, topicKey: string): string {
  return `[${category}] ${normalizeArea(area)}: ${normalizeTopicKey(topicKey).replace(/-/g, ' ')}`;
}
