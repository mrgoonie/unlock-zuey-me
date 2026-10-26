/**
 * Pure draft logic for the mission runner: local edits that the server has not acknowledged yet ("dirty"
 * fields), merging them over a newer server run after a 409, and a stable idempotency key per submit attempt.
 * Kept free of React/DOM so it is unit-tested directly (tests/unit/ui-run-draft.test.ts).
 */
import { lockedFieldIds } from '../learning/reveal-keys';
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
  updatedAt: string;
}

export const emptyDraft = (runId: string, missionId: string): RunDraft => ({
  runId, missionId, answers: {}, dirty: {}, imageKeys: [], confidence: null, attempt: null, hints: {},
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

/** Drops the dirty flags of `fields` in `stepId` (their local values are then replaced by the next merge). */
export function clearDirtyFields(draft: RunDraft, stepId: string, fields: readonly string[]): RunDraft {
  const remaining = (draft.dirty[stepId] ?? []).filter((f) => !fields.includes(f));
  const dirty = { ...draft.dirty };
  if (remaining.length) dirty[stepId] = remaining;
  else delete dirty[stepId];
  return { ...draft, dirty };
}

/**
 * Drops every unsaved edit of `stepId` and adopts the server run (its value wins in that step); unsaved
 * edits of other steps are re-applied on top and stay dirty.
 */
export function discardStepEdits(draft: RunDraft, stepId: string, server: Pick<MissionRun, 'answers'>): RunDraft {
  return mergeServerRun(clearDirtyFields(draft, stepId, draft.dirty[stepId] ?? []), server);
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

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isAnswerValue = (v: unknown): v is AnswerValue =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || isStringArray(v);

/** {stepId: {fieldId: string | string[] | number}}, or null when any part has another shape. */
function parseAnswers(v: unknown): Answers | null {
  if (!isRecord(v)) return null;
  for (const fields of Object.values(v)) {
    if (!isRecord(fields) || !Object.values(fields).every(isAnswerValue)) return null;
  }
  return v as Answers;
}

/** {stepId: fieldIds[]}, or null when malformed. */
const parseDirty = (v: unknown): DirtyMap | null =>
  isRecord(v) && Object.values(v).every(isStringArray) ? (v as DirtyMap) : null;

const isHint = (v: unknown): boolean => isRecord(v) && [1, 2, 3, 4].includes(v.level as number) && typeof v.text === 'string';
const parseHints = (v: unknown): RunDraft['hints'] | null =>
  isRecord(v) && Object.values(v).every((list) => Array.isArray(list) && list.every(isHint)) ? (v as RunDraft['hints']) : null;

const parseAttempt = (v: unknown): RunDraft['attempt'] =>
  isRecord(v) && typeof v.key === 'string' && v.key.length >= 8 && typeof v.fingerprint === 'string' ? { key: v.key, fingerprint: v.fingerprint } : null;

/**
 * Validates a stored draft (localStorage is user-writable and survives app updates, so it is untrusted).
 * Returns null when the draft is unusable: not JSON, another run, or answers of the wrong shape. Malformed
 * optional parts are reset instead: a bad `dirty` map is dropped (those unsaved edits are lost, the server
 * copy wins), as are bad hints, images, confidence or attempt. Never throws.
 */
export function parseStoredDraft(raw: string, runId: string): RunDraft | null {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(d) || d.runId !== runId) return null;
  const answers = parseAnswers(d.answers);
  if (!answers) return null;
  const base = emptyDraft(runId, typeof d.missionId === 'string' ? d.missionId : '');
  // Dirty fields only make sense with a value to save: drop flags whose value is missing.
  const dirtyIn = parseDirty(d.dirty) ?? {};
  const dirty: DirtyMap = {};
  for (const [stepId, fields] of Object.entries(dirtyIn)) {
    const kept = [...new Set(fields)].filter((f) => answers[stepId]?.[f] !== undefined);
    if (kept.length) dirty[stepId] = kept;
  }
  const confidence = typeof d.confidence === 'number' && Number.isFinite(d.confidence) && d.confidence >= 0 && d.confidence <= 100
    ? d.confidence : null;
  return {
    ...base,
    answers,
    dirty,
    imageKeys: isStringArray(d.imageKeys) ? d.imageKeys : [],
    confidence,
    attempt: parseAttempt(d.attempt),
    hints: parseHints(d.hints) ?? {},
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : base.updatedAt,
  };
}

/**
 * The stored draft of a run, or null. An unusable stored draft is removed so it cannot block the runner
 * on the next visit either.
 */
export function loadDraft(runId: string, storage: Storage | undefined = globalThis.localStorage): RunDraft | null {
  let raw: string | null | undefined;
  try {
    raw = storage?.getItem(storageKey(runId));
  } catch {
    return null;
  }
  if (!raw) return null;
  const draft = parseStoredDraft(raw, runId);
  if (!draft) removeDraft(runId, storage);
  return draft;
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

/**
 * Initial draft on load: server answers plus any unsaved local edits from a previous visit. Fields locked by
 * a reveal (possibly made on another device) always take the server value: the server refuses to change
 * them, and the shown choice/verdict must match the revealed answer.
 */
export function restoreDraft(run: MissionRun, local: RunDraft | null): RunDraft {
  let base: RunDraft = local ?? emptyDraft(run.id, run.missionId);
  const revealed = Array.isArray(run.revealed) ? run.revealed : [];
  for (const stepId of Object.keys(base.dirty)) base = clearDirtyFields(base, stepId, lockedFieldIds(revealed, stepId));
  const merged = mergeServerRun({ ...base, missionId: run.missionId }, run);
  return { ...merged, confidence: merged.confidence ?? run.confidence };
}
