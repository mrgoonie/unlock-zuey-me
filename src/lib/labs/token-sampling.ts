/**
 * Next-token sampling maths for the token-predictor lab. Pure functions so the temperature slider and the
 * "let the machine guess" button behave the same in tests and in the browser.
 */
export interface TokenOption {
  token: string;
  /** Authored probability at temperature 1 (need not sum to exactly 1; it is normalised). */
  p: number;
}

/** Temperatures below this are treated as greedy decoding (always the top token). */
export const MIN_TEMPERATURE = 0.05;

/** Normalise weights so they sum to 1. Non-positive or non-finite weights count as 0. */
export function normalise(options: TokenOption[]): TokenOption[] {
  const clean = options.map((o) => ({ ...o, p: Number.isFinite(o.p) && o.p > 0 ? o.p : 0 }));
  const sum = clean.reduce((s, o) => s + o.p, 0);
  if (sum === 0) return clean.map((o) => ({ ...o, p: 1 / Math.max(clean.length, 1) }));
  return clean.map((o) => ({ ...o, p: o.p / sum }));
}

/** Index of the most likely option (ties keep the first). */
export const topIndex = (options: TokenOption[]): number =>
  options.reduce((best, o, i) => (o.p > options[best].p ? i : best), 0);

/**
 * Re-weight a distribution by temperature: p_i^(1/T), renormalised (same as softmax(logit / T)).
 * Low T sharpens towards the top token; high T flattens towards uniform.
 */
export function applyTemperature(options: TokenOption[], temperature: number): TokenOption[] {
  const base = normalise(options);
  if (base.length === 0) return base;
  if (!(temperature >= MIN_TEMPERATURE)) {
    const top = topIndex(base);
    return base.map((o, i) => ({ ...o, p: i === top ? 1 : 0 }));
  }
  const maxLog = Math.max(...base.map((o) => (o.p > 0 ? Math.log(o.p) : -Infinity)));
  const weights = base.map((o) => (o.p > 0 ? Math.exp((Math.log(o.p) - maxLog) / temperature) : 0));
  return normalise(base.map((o, i) => ({ ...o, p: weights[i] })));
}

/** Pick one option given a uniform random number in [0, 1). */
export function sampleIndex(options: TokenOption[], rand: number): number {
  const dist = normalise(options);
  let acc = 0;
  for (let i = 0; i < dist.length; i++) {
    acc += dist[i].p;
    if (rand < acc) return i;
  }
  return dist.length - 1;
}

/** Small seeded PRNG (mulberry32) so sampling demos are reproducible in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw `n` samples and count how often each option was picked. */
export function sampleMany(options: TokenOption[], n: number, rand: () => number): number[] {
  const counts = options.map(() => 0);
  for (let i = 0; i < n; i++) counts[sampleIndex(options, rand())]++;
  return counts;
}
