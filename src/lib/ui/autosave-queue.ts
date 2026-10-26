/**
 * Serialized autosave for runner drafts (framework-free so it is unit-tested directly).
 *
 * Invariant: at most one PATCH /answers is in flight. Every flush() joins a single promise chain; flushes
 * requested while a drain is still queued (not started) share that drain, and a drain always reads the
 * newest draft and the newest run `rev` (from the previous response) before each PATCH, so rapid edits are
 * coalesced into sequential saves with increasing rev instead of parallel saves with the same rev.
 *
 * Rejections the queue resolves itself:
 * - 409 conflict: adopt the server run, re-apply local edits on top, save again with the new rev.
 * - 403 `answer_locked` with the server run in the body (an edit touches an answer whose key was already
 *   revealed, so the server locked it): adopt that run, restore the server value of the locked fields only,
 *   tell the learner calmly and keep saving the other edits. Without this the step stays dirty forever and
 *   blocks every later save and the submit.
 *
 * Every other failure, including a generic or non-JSON 403 (edge WAF/bot challenge, origin check), keeps all
 * local edits dirty and reports the save as 'offline'; a refused save also gets a neutral notice. Local edits
 * are never discarded on a signal the server did not send explicitly.
 */
import type { Answers, MissionRun } from '../learning/types';
import { lockedFieldIds } from '../learning/reveal-keys';
import { ApiError } from './api-client';
import { clearDirtyFields, hasDirty, markSaved, mergeServerRun, type RunDraft } from './run-draft';

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline';

export interface SaveQueueDeps {
  getDraft: () => RunDraft | null;
  getRun: () => MissionRun | null;
  setDraft: (d: RunDraft) => void;
  setRun: (r: MissionRun) => void;
  currentStepId: () => string | undefined;
  save: (runId: string, input: { stepId: string; answers: Answers[string]; currentStep?: string; rev: number }) => Promise<{ run: MissionRun }>;
  onState: (s: SaveState) => void;
  /** Calm, learner-facing notice (e.g. a locked answer was restored). */
  onNotice?: (message: string) => void;
}

export const LOCKED_ANSWER_NOTICE = 'Câu này đã xem đáp án nên được giữ nguyên.';
/** Neutral notice when the server refused a save for another reason: nothing local is lost. */
export const SAVE_REFUSED_NOTICE = 'Chưa lưu được lên máy chủ. Bài làm vẫn được giữ trên máy này, bạn thử lại sau nhé.';

const MAX_CONFLICT_RETRIES = 3;
/**
 * Lock recoveries per step in one drain. One is normally enough; a second covers a reveal made elsewhere
 * between the two saves. After that the save is reported as failed (edits kept), never reset.
 */
const MAX_LOCK_RECOVERIES = 2;
/** Safety valve against a pathological loop; real drains need one PATCH per dirty step. */
const MAX_SAVES_PER_DRAIN = 50;

export const isRun = (v: unknown): v is MissionRun =>
  !!v && typeof v === 'object' && typeof (v as MissionRun).rev === 'number' && typeof (v as MissionRun).answers === 'object';

/** The server run carried by an explicit `answer_locked` 403 for `runId`; null for any other error. */
export function lockedServerRun(e: unknown, runId: string): MissionRun | null {
  if (!(e instanceof ApiError) || e.code !== 'answer_locked' || e.status !== 403) return null;
  const run = (e.body as { run?: unknown } | null)?.run;
  return isRun(run) && run.id === runId && Array.isArray(run.revealed) ? run : null;
}

export function createSaveQueue(deps: SaveQueueDeps) {
  /** Steps to PATCH even when clean (records the current step on navigation). */
  const forced = new Set<string>();
  let tail: Promise<boolean> = Promise.resolve(true);
  /** A drain that is queued but has not started yet: new flush requests join it. */
  let queued: Promise<boolean> | null = null;
  let running = false;

  async function drain(): Promise<boolean> {
    let conflicts = 0;
    /** Lock recoveries per step in this drain (see MAX_LOCK_RECOVERIES). */
    const lockedHits = new Map<string, number>();
    for (let i = 0; i < MAX_SAVES_PER_DRAIN; i++) {
      const draft = deps.getDraft();
      const run = deps.getRun();
      if (!draft || !run) return false;
      const stepIds = Object.keys(draft.dirty).filter((s) => draft.dirty[s]?.length);
      for (const f of forced) if (!stepIds.includes(f)) stepIds.push(f);
      if (!stepIds.length) {
        deps.onState('saved');
        return true;
      }
      const stepId = stepIds[0];
      const sent = { ...(draft.answers[stepId] ?? {}) };
      deps.onState('saving');
      try {
        const res = await deps.save(run.id, { stepId, answers: sent, currentStep: deps.currentStepId(), rev: run.rev });
        deps.setRun(res.run);
        deps.setDraft(markSaved(deps.getDraft() ?? draft, stepId, sent));
        forced.delete(stepId);
      } catch (e) {
        const server = e instanceof ApiError && e.code === 'conflict' ? (e.body as { run?: unknown } | null)?.run : undefined;
        if (isRun(server) && conflicts < MAX_CONFLICT_RETRIES) {
          conflicts += 1;
          deps.setRun(server);
          deps.setDraft(mergeServerRun(deps.getDraft() ?? draft, server));
          continue;
        }
        const locked = lockedServerRun(e, run.id);
        const hits = lockedHits.get(stepId) ?? 0;
        const fields = locked ? lockedFieldIds(locked.revealed, stepId) : [];
        // Only the fields the server's reveals lock are replaced; every other local edit stays dirty.
        if (locked && fields.length && hits < MAX_LOCK_RECOVERIES) {
          lockedHits.set(stepId, hits + 1);
          deps.setRun(locked);
          deps.setDraft(mergeServerRun(clearDirtyFields(deps.getDraft() ?? draft, stepId, fields), locked));
          deps.onNotice?.(LOCKED_ANSWER_NOTICE);
          continue;
        }
        if (e instanceof ApiError && e.status === 403) deps.onNotice?.(SAVE_REFUSED_NOTICE);
        deps.onState('offline');
        return false;
      }
    }
    deps.onState('offline');
    return false;
  }

  /** Queue a save of everything dirty (plus `forceStepId`). Resolves true when that drain saved it all. */
  function flush(forceStepId?: string): Promise<boolean> {
    if (forceStepId) forced.add(forceStepId);
    if (queued) return queued;
    const p = tail.catch(() => false).then(async () => {
      queued = null;
      running = true;
      try {
        return await drain();
      } finally {
        running = false;
      }
    });
    queued = p;
    tail = p;
    return p;
  }

  /** True while a save is running or queued, or local edits are not yet saved. */
  const pending = (): boolean => running || queued !== null || hasDirty(deps.getDraft() ?? ({ dirty: {} } as RunDraft)) || forced.size > 0;

  /** Waits until nothing is pending (edits made during a save are saved too). False if a save failed. */
  async function settle(maxRounds = 10): Promise<boolean> {
    for (let i = 0; i < maxRounds; i++) {
      const ok = await flush();
      if (!ok) return false;
      if (!pending()) return true;
    }
    return !pending();
  }

  return { flush, settle, pending };
}

export type SaveQueue = ReturnType<typeof createSaveQueue>;
