/** Opaque ids with a readable prefix (lrn_, ses_, run_, sub_, evl_, evt_ ...) and ISO timestamps. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return `${prefix}_${s}`;
}

export const nowIso = (d: Date = new Date()): string => d.toISOString();

/** Parses a JSON column, returning `fallback` for NULL or corrupt values instead of throwing. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
