/**
 * Debounced autosave of runner drafts to PATCH /api/v1/runs/:id/answers with optimistic locking.
 * - Every edit is mirrored to localStorage immediately (nothing is lost offline or on AI errors).
 * - Saves are serialized by src/lib/ui/autosave-queue.ts: one PATCH in flight, newest rev, edits coalesced.
 * - On 409 the server run is adopted and unsaved local edits are re-applied on top, then saved again.
 * - On 403 `answer_locked` (an answer whose key was revealed is locked) only the locked fields get the server
 *   value back and `notice` explains it; any other 403 keeps every local edit and shows a neutral notice.
 * - When lock recovery cannot fix a step (client and server disagree on what is locked), `lockedStepId` is set
 *   and `reloadLockedStep()` reloads the server run, discarding that step's unsaved edits only.
 * - Network failures keep the dirty flags; the next edit, step change or `online` event retries.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { MissionRun } from '../../lib/learning/types';
import { api } from '../../lib/ui/api-client';
import { createSaveQueue, type SaveState } from '../../lib/ui/autosave-queue';
import { saveDraft, type RunDraft } from '../../lib/ui/run-draft';

export type { SaveState };

const DEBOUNCE_MS = 800;
const RELOAD_FAILED_NOTICE = 'Chưa tải lại được (có thể do mạng). Bài làm vẫn được giữ trên máy này, bạn thử lại sau nhé.';

export function useRunAutosave(opts: {
  draftRef: RefObject<RunDraft | null>;
  runRef: RefObject<MissionRun | null>;
  setDraft: (d: RunDraft) => void;
  setRun: (r: MissionRun) => void;
  currentStepId: () => string | undefined;
  /** Loads the run from the server (reloadLockedStep); may refresh other session state on the way. */
  fetchRun: (runId: string) => Promise<MissionRun>;
}) {
  const { draftRef, runRef, setDraft, setRun, currentStepId, fetchRun } = opts;
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  /** Step whose save the server keeps refusing as locked (see autosave-queue onLockExhausted). */
  const [lockedStepId, setLockedStepId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitDraft = useCallback((d: RunDraft) => {
    draftRef.current = d;
    saveDraft(d);
    setDraft(d);
  }, [draftRef, setDraft]);

  // One queue per runner instance; deps read refs so the queue always sees the newest draft and rev.
  const queueRef = useRef<ReturnType<typeof createSaveQueue> | null>(null);
  const depsRef = useRef({ commitDraft, setRun, currentStepId, fetchRun });
  depsRef.current = { commitDraft, setRun, currentStepId, fetchRun };
  queueRef.current ??= createSaveQueue({
    getDraft: () => draftRef.current,
    getRun: () => runRef.current,
    setDraft: (d) => depsRef.current.commitDraft(d),
    setRun: (r) => { runRef.current = r; depsRef.current.setRun(r); },
    currentStepId: () => depsRef.current.currentStepId(),
    save: (runId, input) => api.saveAnswers(runId, input),
    onState: (st) => {
      setSaveState(st);
      if (st === 'saved') setLockedStepId(null);
    },
    onNotice: setNotice,
    onLockExhausted: setLockedStepId,
    fetchRun: (runId) => depsRef.current.fetchRun(runId),
  });
  const queue = queueRef.current;

  const cancelTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /** Save now (plus `forceStepId` to record the current step). Resolves true when everything saved. */
  const flush = useCallback((forceStepId?: string): Promise<boolean> => {
    cancelTimer();
    return queue.flush(forceStepId);
  }, [queue]);

  /** Waits until no save is running, queued or needed (used before submit). */
  const settle = useCallback((): Promise<boolean> => {
    cancelTimer();
    return queue.settle();
  }, [queue]);

  /** Call after each local edit: persists locally now, saves to the server after a short pause. */
  const schedule = useCallback((d: RunDraft) => {
    setNotice(null);
    commitDraft(d);
    cancelTimer();
    timer.current = setTimeout(() => void queue.flush(), DEBOUNCE_MS);
  }, [commitDraft, queue]);

  /** Reloads the server copy of the locked step (its unsaved edits are dropped), then saves the rest. */
  const reloadLockedStep = useCallback(async (): Promise<void> => {
    const stepId = lockedStepId;
    if (!stepId) return;
    cancelTimer();
    setNotice(null);
    const { reloaded } = await queue.reloadStep(stepId);
    // A failed save of the other steps is shown by the save state (and may flag another step itself).
    if (reloaded) setLockedStepId((cur) => (cur === stepId ? null : cur));
    else setNotice(RELOAD_FAILED_NOTICE);
  }, [lockedStepId, queue]);

  /** Forgets pending autosave state (the run was replaced, e.g. after "Bỏ lượt này"). */
  const reset = useCallback(() => {
    cancelTimer();
    setNotice(null);
    setLockedStepId(null);
    setSaveState('idle');
  }, []);

  useEffect(() => {
    const onOnline = () => void flush();
    const onHide = () => { if (document.visibilityState === 'hidden') void flush(); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onHide);
      cancelTimer();
    };
  }, [flush]);

  return { saveState, notice, lockedStepId, flush, settle, schedule, commitDraft, reloadLockedStep, reset };
}
