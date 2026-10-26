/**
 * Pure draft logic for the mission runner: local edits that the server has not acknowledged yet ("dirty"
 * fields), merging them over a newer server run after a 409, and a stable idempotency key per submit attempt.
 * Kept free of React/DOM so it is unit-tested directly (tests/unit/ui-run-draft.test.ts).
 */
import type { Answers, HintResult, MissionRun } from '../learning/types';

export type AnswerValue = Answers[string][string];
/** {stepId: fieldIds edited locally and not yet saved}. */
export type DirtyMap = Record<string, string[]>;

export interface RunDraft {
  runId: string;
  missionId: string;
  answers: Answers;
  dirty: DirtyMap;
  /** Evidence screenshots uploaded for this run (sent with submit). */
  imageKeys: string[];
  confidence: number | null;
  /** Idempotency key of the current submit attempt and the evidence fingerprint it was issued for. */
  attempt: { key: string; fingerprint: string } | null;
  /** Hints already revealed per step (so a reload does not cost another hint). */
  hints: Record<string, HintResult[]>;
  /** "stepId:questionId" keys whose explanation was revealed (answer locked for that question). */
  revealed: string[];
  updatedAt: string;
}

export const emptyDraft = (runId: string, missionId: string): RunDraft => ({
  runId, missionId, answers: {}, dirty: {}, imageKeys: [], confidence: null, attempt: null, hints: {}, revealed: [],
  updatedAt: new Date(0).toISOString(),
});

/** Sets one field value and marks it dirty. Returns a new draft (inputs are not mutated). */
export function setField(draft: RunDraft, stepId: string, fieldId: string, value: AnswerValue): RunDraft {
  const stepDirty = draft.dirty[stepId] ?? [];
  return {
    ...draft,
    answers: { ...draft.answers, [stepId]: { ...(draft.answers[stepId] ?? {}), [fieldId]: value } },
    dirty: { ...draft.dirty, [stepId]: stepDirty.includes(fieldId) ? stepDirty : [...stepDirty, fieldId] },
    updatedAt: new Date().toISOString(),
  };
}

const same = (a: AnswerValue | undefined, b: AnswerValue | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * After a successful save of `sent` for `stepId`: clears dirty flags only for fields whose current value is
 * still what was sent (edits typed while the request was in flight stay dirty and are saved next).
 */
export function markSaved(draft: RunDraft, stepId: string, sent: Answers[string]): RunDraft {
  const remaining = (draft.dirty[stepId] ?? []).filter((f) => !same(draft.answers[stepId]?.[f], sent[f]));
  const dirty = { ...draft.dirty };
  if (remaining.length) dirty[stepId] = remaining;
  else delete dirty[stepId];
  return { ...draft, dirty };
}

/**
 * 409 resolution: adopt the server's answers as the base, then re-apply every locally dirty field on top so
 * nothing the learner typed is lost. Dirty flags are kept so the merged values are saved with the new rev.
 */
export function mergeServerRun(draft: RunDraft, server: Pick<MissionRun, 'answers'>): RunDraft {
  const answers: Answers = {};
  for (const [stepId, fields] of Object.entries(server.answers ?? {})) answers[stepId] = { ...fields };
  for (const [stepId, fieldIds] of Object.entries(draft.dirty)) {
    for (const f of fieldIds) {
      const local = draft.answers[stepId]?.[f];
      if (local === undefined) continue;
      answers[stepId] = { ...(answers[stepId] ?? {}), [f]: local };
    }
  }
  return { ...draft, answers };
}

export const hasDirty = (draft: RunDraft): boolean => Object.values(draft.dirty).some((f) => f.length > 0);

/** Deterministic fingerprint of what a submit would send (answers, confidence, images). */
export function evidenceFingerprint(draft: Pick<RunDraft, 'answers' | 'confidence' | 'imageKeys'>): string {
  const sortObj = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortObj);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortObj((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sortObj({ a: draft.answers, c: draft.confidence, i: [...draft.imageKeys].sort() }));
}

/**
 * Returns the draft with an idempotency key for the current evidence. The same evidence reuses the same key
 * (safe retries after timeouts or evaluation_failed: the server never grants twice); changed evidence
 * (e.g. fixing a needs_revision) is a new attempt and gets a fresh key.
 */
export function ensureAttemptKey(draft: RunDraft, newKey: () => string = () => crypto.randomUUID()): RunDraft {
  const fingerprint = evidenceFingerprint(draft);
  if (draft.attempt && draft.attempt.fingerprint === fingerprint) return draft;
  return { ...draft, attempt: { key: newKey(), fingerprint } };
}

/** Forget the attempt once the server returned a definitive grade (passed / needs_revision). */
export const clearAttempt = (draft: RunDraft): RunDraft => ({ ...draft, attempt: null });

// ---- localStorage mirror (best effort: private mode / quota errors are ignored) ----

const storageKey = (runId: string) => `aiu:draft:${runId}`;

export function loadDraft(runId: string, storage: Storage | undefined = globalThis.localStorage): RunDraft | null {
  try {
    const raw = storage?.getItem(storageKey(runId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<RunDraft>;
    if (d.runId !== runId || typeof d.answers !== 'object' || d.answers === null) return null;
    return { ...emptyDraft(runId, d.missionId ?? ''), ...d } as RunDraft;
  } catch {
    return null;
  }
}

export function saveDraft(draft: RunDraft, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(storageKey(draft.runId), JSON.stringify(draft));
  } catch {
    /* storage full or unavailable: the server copy is still authoritative */
  }
}

export function removeDraft(runId: string, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(storageKey(runId));
  } catch {
    /* ignore */
  }
}

/** Initial draft on load: server answers plus any unsaved local edits from a previous visit. */
export function restoreDraft(run: MissionRun, local: RunDraft | null): RunDraft {
  const base: RunDraft = local ?? emptyDraft(run.id, run.missionId);
  const merged = mergeServerRun({ ...base, missionId: run.missionId }, run);
  return { ...merged, confidence: merged.confidence ?? run.confidence };
}
