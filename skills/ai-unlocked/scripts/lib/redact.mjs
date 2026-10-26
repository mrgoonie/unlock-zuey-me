// Shared redaction rules for the ai-unlocked skill (Stop hook, Node >= 18 on the learner's machine) and the
// unlock.zuey.me Worker (server-side defense in depth). One rule set, two call sites: keep this file pure,
// dependency-free and import-free so both runtimes load it unchanged. Types: redact.d.mts.
//
// Every rule replaces a match with `[REDACTED:<kind>]` (home paths become `~`), so running the redaction
// again on its own output finds nothing new. Quantifiers are bounded and input is capped before any rule
// runs, so no rule can backtrack catastrophically on a 32 KB payload.

/** Longest input (in UTF-16 code units) a single call redacts; anything after it is dropped. */
export const REDACT_MAX_INPUT = 65536;

/** Deepest nesting `redactValue` walks; deeper values are replaced with null. */
const MAX_DEPTH = 16;

const MARK = (kind) => `[REDACTED:${kind}]`;

/** True when `digits` (only 0-9) passes the Luhn checksum used by payment card numbers. */
function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A base64-ish run counts as a secret only when it mixes upper case, lower case and digits. */
function looksRandomBase64(s) {
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
}

/**
 * Ordered rules. Specific credential formats run before the generic ones so the reported kind is precise;
 * `replace` returns the replacement text, or null to keep the match (e.g. a digit run failing Luhn).
 * @type {Array<{ kind: string, re: RegExp, replace?: (m: string, ...groups: string[]) => string | null }>}
 */
const RULES = [
  // PEM blocks (keys, certificates). An unterminated block is redacted to the end of the input.
  { kind: 'private_key', re: /-----BEGIN ([A-Z0-9 ]{1,40})-----[\s\S]{0,16384}?(?:-----END \1-----|$)/g },
  { kind: 'ingest_token', re: /\baiu_ing_[A-Za-z0-9_-]{20,128}/g },
  // OpenAI (sk-, sk-proj-), Anthropic (sk-ant-), OpenRouter (sk-or-).
  { kind: 'api_key', re: /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,256}/g },
  { kind: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g },
  { kind: 'aws_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    kind: 'aws_secret',
    re: /(aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi,
    replace: (_m, label) => `${label}${MARK('aws_secret')}`,
  },
  { kind: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,255}/g },
  { kind: 'google_key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{4,8192}\.[A-Za-z0-9_-]{0,4096}/g },
  {
    kind: 'bearer',
    re: /\b(Bearer|Basic|Token)([ \t]{1,8})(?!\[REDACTED:)([A-Za-z0-9._~+/=-]{8,4096})/gi,
    replace: (_m, scheme, space) => `${scheme}${space}${MARK('bearer')}`,
  },
  // Secret-looking query parameters (before the generic key=value rule so the kind stays precise).
  {
    kind: 'url_secret',
    re: /([?&](?:access_token|refresh_token|id_token|token|key|api_key|apikey|secret|client_secret|sig|signature|password|code)=)(?!\[REDACTED:)[^&#\s"'<>]{1,2048}/gi,
    replace: (_m, name) => `${name}${MARK('url_secret')}`,
  },
  // key = value / "key": "value" where the key names a credential (MY_API_KEY=…, password: …, mật khẩu: …).
  {
    kind: 'secret',
    re: /((?<![A-Za-z0-9])(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|mật khẩu|mat_?khau)[A-Za-z0-9_.-]{0,40}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)(?!\[REDACTED:)([^\s"'`,;&<>]{3,512})/gi,
    // A bare number after a "token" key is a count (max_tokens: 900), not a credential.
    replace: (m, label, value) => (/token/i.test(label) && /^\d{1,9}$/.test(value) ? null : `${label}${MARK('secret')}`),
  },
  { kind: 'email', re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g },
  // Home directories reveal the OS user name: /Users/<name>, /home/<name>, C:\Users\<name> → ~.
  { kind: 'home_path', re: /(?:\/Users|\/home)\/[^/\s"'`]{1,64}|\b[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"'`]{1,64}/g, replace: () => '~' },
  // Vietnamese national id (CCCD 12 digits, CMND 9 digits) next to its label; the label is kept.
  {
    kind: 'national_id',
    re: /((?:CCCD|CMND|CMT|căn cước|can cuoc|chứng minh(?: nhân dân| thư)?|chung minh)[^0-9\n]{0,20})(\d{12}|\d{9})(?!\d)/gi,
    replace: (_m, label) => `${label}${MARK('national_id')}`,
  },
  // Payment cards: 13–19 digits (optional single space or dash separators) passing Luhn.
  {
    kind: 'card',
    re: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    replace: (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? MARK('card') : null;
    },
  },
  // Standalone 12-digit number: treated as a CCCD even without its label.
  { kind: 'national_id', re: /(?<![\d.-])\d{12}(?![\d.-])/g },
  // Vietnamese mobile numbers: +84 / 0 then 3, 5, 7, 8 or 9 and 8 more digits (single space/dot/dash allowed).
  { kind: 'phone', re: /(?<![\d+])(?:\+84|0)[ .-]?[35789]\d(?:[ .-]?\d){7}(?!\d)/g },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g },
  {
    kind: 'ip',
    re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g,
    // Loopback and the unspecified address identify nobody and help explain local dev errors.
    replace: (m) => (m === '127.0.0.1' || m === '0.0.0.0' ? null : MARK('ip')),
  },
  // Generic high-entropy runs: long hex, or long base64/base64url mixing cases and digits.
  {
    kind: 'high_entropy',
    re: /(?<![A-Za-z0-9])[0-9a-fA-F]{32,32768}(?![A-Za-z0-9])/g,
    replace: (m) => (/[0-9]/.test(m) && /[a-fA-F]/.test(m) ? MARK('high_entropy') : null),
  },
  {
    kind: 'high_entropy',
    re: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{32,32768}={0,2}(?![A-Za-z0-9+/=_-])/g,
    replace: (m) => (looksRandomBase64(m) ? MARK('high_entropy') : null),
  },
];

/**
 * Redacts secrets and personal data from one string.
 * @param {string} text
 * @returns {{ text: string, count: number, kinds: string[] }}
 */
export function redactText(text) {
  if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', count: 0, kinds: [] };
  let out = text.length > REDACT_MAX_INPUT ? text.slice(0, REDACT_MAX_INPUT) : text;
  let count = 0;
  const kinds = new Set();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args) => {
      const m = args[0];
      // replace() passes (match, ...groups, offset, input[, namedGroups]); keep only the capture groups.
      const groups = args.slice(1).filter((a) => typeof a === 'string' || a === undefined).slice(0, -1);
      const replacement = rule.replace ? rule.replace(m, ...groups) : MARK(rule.kind);
      if (replacement === null || replacement === m) return m;
      count++;
      kinds.add(rule.kind);
      return replacement;
    });
  }
  return { text: out, count, kinds: [...kinds].sort() };
}

/**
 * Redacts every string inside a JSON-like value (object keys are kept as they are). Non-JSON values
 * (functions, symbols, bigint) and anything nested deeper than 16 levels become null.
 * @param {unknown} value
 * @returns {{ value: unknown, count: number, kinds: string[] }}
 */
export function redactValue(value) {
  let count = 0;
  const kinds = new Set();
  const walk = (v, depth) => {
    if (typeof v === 'string') {
      const r = redactText(v);
      count += r.count;
      for (const k of r.kinds) kinds.add(k);
      return r.text;
    }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (depth >= MAX_DEPTH) return null;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue;
        out[k] = walk(x, depth + 1);
      }
      return out;
    }
    return null;
  };
  const out = walk(value, 0);
  return { value: out, count, kinds: [...kinds].sort() };
}
