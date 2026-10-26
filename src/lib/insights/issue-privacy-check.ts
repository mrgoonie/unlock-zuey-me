/**
 * Privacy re-scan of a GitHub issue body (pure, no I/O). The body must carry no secrets (shared redaction
 * rules), internal ids, emails, URLs other than unlock.zuey.me, contributors' display names, or any text
 * copied from learner evidence.
 *
 * Copy detection works on normalised text (lower case, Vietnamese diacritics folded, punctuation and
 * whitespace collapsed) so re-casing or re-punctuating a quote does not hide it. A hit is either a shared
 * run of ≥ 40 normalised characters or a shared run of 8 consecutive words, whichever is found first.
 */
import { redactText } from '../../../skills/ai-unlocked/scripts/lib/redact.mjs';
import { foldVietnamese } from './signal-fingerprint';

/** Shortest shared normalised character run that counts as copied evidence. */
export const VERBATIM_CHAR_RUN = 40;
/** Shortest shared run of consecutive words that counts as copied evidence. */
export const VERBATIM_WORD_RUN = 8;

export type PrivacyHitKind = 'redaction' | 'internal_id' | 'email' | 'url' | 'verbatim_evidence' | 'forbidden_term';

export interface PrivacyResult {
  ok: boolean;
  /** Kinds of hits only; the offending text is never echoed. */
  hits: PrivacyHitKind[];
}

const MARKER_RE = /ai-unlocked-fp:[0-9a-f]{64}/g;
const INTERNAL_ID_RE = /\b(?:lrn|run|evt|ses|sub|evl|iev|irp|itk)_[a-z0-9]{4,}/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /\b(?:https?:\/\/|www\.)([^\s/?#)\]>"'`]+)/gi;
const BARE_DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|me|vn|co|info|xyz))\b/gi;
const ALLOWED_HOSTS = new Set(['unlock.zuey.me']);

/** Lower case, diacritics folded, every non-alphanumeric run collapsed to one space. */
export function normalizeForCopyCheck(s: string): string {
  return foldVietnamese(s).replace(/[^a-z0-9]+/g, ' ').trim();
}

const wordRuns = (words: string[], n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '));
  return out;
};

/** True when `body` (already normalised) shares a 40-character run or an 8-word run with `evidence`. */
export function copiesEvidence(normalizedBody: string, evidence: string): boolean {
  const e = normalizeForCopyCheck(evidence);
  if (!e) return false;
  for (let i = 0; i + VERBATIM_CHAR_RUN <= e.length; i++) {
    if (normalizedBody.includes(e.slice(i, i + VERBATIM_CHAR_RUN))) return true;
  }
  const bodyRuns = new Set(wordRuns(normalizedBody.split(' '), VERBATIM_WORD_RUN));
  return wordRuns(e.split(' '), VERBATIM_WORD_RUN).some((run) => bodyRuns.has(run));
}

/** Re-scan of an issue body. The fingerprint marker is the only hash allowed. */
export function privacyCheck(markdown: string, opts: { evidence?: string[]; forbiddenTerms?: string[] } = {}): PrivacyResult {
  const text = markdown.replace(MARKER_RE, 'ai-unlocked-fp');
  const hits = new Set<PrivacyHitKind>();
  if (redactText(text).count > 0) hits.add('redaction');
  if (INTERNAL_ID_RE.test(text)) hits.add('internal_id');
  if (EMAIL_RE.test(text)) hits.add('email');
  for (const m of text.matchAll(URL_RE)) if (!ALLOWED_HOSTS.has(m[1].toLowerCase())) hits.add('url');
  for (const m of text.matchAll(BARE_DOMAIN_RE)) {
    const host = m[1].toLowerCase();
    if (!ALLOWED_HOSTS.has(host) && host !== 'zuey.me') hits.add('url');
  }
  if (opts.evidence?.length) {
    const body = normalizeForCopyCheck(text);
    if (opts.evidence.some((e) => copiesEvidence(body, e))) hits.add('verbatim_evidence');
  }
  const lower = text.toLowerCase();
  for (const term of opts.forbiddenTerms ?? []) {
    const t = term.trim().toLowerCase();
    if (t.length >= 3 && lower.includes(t)) hits.add('forbidden_term');
  }
  return { ok: hits.size === 0, hits: [...hits].sort() };
}
