/**
 * A deliberately simple, deterministic tokenizer *approximation* for teaching. Real tokenizers (BPE) learn
 * their pieces from data; this one only mimics the visible effect: common English words are ~1 token,
 * while Vietnamese syllables with diacritics are usually split into 2 or more pieces.
 *
 * Rules:
 * - Text is split into words (letters/digits) and single punctuation marks; whitespace sticks to the
 *   following piece, as in BPE vocabularies (" trời").
 * - Plain ASCII words: one token per 8 characters.
 * - Words containing a non-ASCII letter: split before the first non-ASCII letter ("ng|ười", "tr|ời");
 *   a word that starts with one splits after its first letter ("đ|ẹp"); the tail is chunked by 3.
 */
export interface ApproxToken {
  text: string;
  index: number;
}

const PIECE = /\s*[\p{L}\p{N}]+|\s*[^\s\p{L}\p{N}]|\s+$/gu;
const NON_ASCII = /[^\x00-\x7F]/;

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function splitWord(core: string): string[] {
  const firstNonAscii = core.search(NON_ASCII);
  if (firstNonAscii === -1) return chunk(core, 8);
  if (core.length === 1) return [core];
  const cut = firstNonAscii === 0 ? 1 : firstNonAscii;
  return [core.slice(0, cut), ...chunk(core.slice(cut), 3)];
}

export function tokenizeApprox(text: string): ApproxToken[] {
  const pieces = text.normalize('NFC').match(PIECE) ?? [];
  const tokens: string[] = [];
  for (const piece of pieces) {
    const lead = piece.match(/^\s*/)?.[0] ?? '';
    const core = piece.slice(lead.length);
    if (!core) {
      tokens.push(piece);
      continue;
    }
    const parts = splitWord(core);
    parts[0] = lead + parts[0];
    tokens.push(...parts);
  }
  return tokens.map((t, index) => ({ text: t, index }));
}

export const countTokensApprox = (text: string): number => tokenizeApprox(text).length;
