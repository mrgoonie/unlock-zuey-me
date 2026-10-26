/**
 * Browser-side recording for labs. Recording must never block or break the lab: every function here
 * swallows network/API errors and reports an outcome instead of throwing. Labs never grant XP.
 */

export interface LabResult {
  score: number;
  total: number;
  /** 0..100 calibration score (token predictor only). */
  calibration?: number;
}

export type RecordOutcome = { ok: true; labsDone: string[] } | { ok: false; reason: 'not_found' | 'error' };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Hand-written guard instead of zod: this module ships to the browser and should stay tiny. */
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const LOCAL_KEY = 'labs.done';

const jsonInit = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'same-origin',
  body: JSON.stringify(body),
});

/** Clamp a result into a valid payload: non-negative integers, score ≤ total, calibration 0..100. */
export function sanitizeResult(r: LabResult): LabResult {
  const total = Math.max(0, Math.round(Number.isFinite(r.total) ? r.total : 0));
  const score = Math.min(total, Math.max(0, Math.round(Number.isFinite(r.score) ? r.score : 0)));
  const out: LabResult = { score, total };
  if (r.calibration !== undefined && Number.isFinite(r.calibration)) {
    out.calibration = Math.min(100, Math.max(0, Math.round(r.calibration)));
  }
  return out;
}

export async function recordLabResult(labId: string, result: LabResult, fetchImpl: FetchLike = fetch): Promise<RecordOutcome> {
  rememberLabDone(labId);
  try {
    const res = await fetchImpl(`/api/v1/labs/${encodeURIComponent(labId)}/result`, jsonInit({ result: sanitizeResult(result) }));
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'error' };
    const body: unknown = await res.json();
    const labsDone = (body as { labsDone?: unknown } | null)?.labsDone;
    return isStringArray(labsDone) ? { ok: true, labsDone } : { ok: false, reason: 'error' };
  } catch (err) {
    console.warn('lab result not recorded', labId, err);
    return { ok: false, reason: 'error' };
  }
}

/** Fire-and-forget analytics event; failures are logged only. */
export function trackLabStarted(labId: string, fetchImpl: FetchLike = fetch): void {
  try {
    fetchImpl('/api/v1/events', jsonInit({ name: 'lab.started', props: { labId } })).catch((err: unknown) =>
      console.warn('lab.started not recorded', err),
    );
  } catch (err) {
    console.warn('lab.started not recorded', err);
  }
}

/** Device-local "done" list so the lab list can show progress even when the API is unavailable. */
export function readLocalLabsDone(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return isStringArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rememberLabDone(labId: string): void {
  try {
    const done = new Set(readLocalLabsDone());
    done.add(labId);
    globalThis.localStorage?.setItem(LOCAL_KEY, JSON.stringify([...done]));
  } catch {
    // Storage can be disabled (private mode); progress still comes from the API.
  }
}
