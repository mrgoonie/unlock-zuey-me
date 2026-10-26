/**
 * Debounced autosave of runner drafts to PATCH /api/v1/runs/:id/answers with optimistic locking.
 * - Every edit is mirrored to localStorage immediately (nothing is lost offline or on AI errors).
 * - Saves are serialized by src/lib/ui/autosave-queue.ts: one PATCH in flight, newest rev, edits coalesced.
 * - On 409 the server run is adopted and unsaved local edits are re-applied on top, then saved again.
 * - Network failures keep the dirty flags; the next edit, step change or `online` event retries.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { MissionRun } from '../../lib/learning/types';
import { api } from '../../lib/ui/api-client';
import { createSaveQueue, type SaveState } from '../../lib/ui/autosave-queue';
import { saveDraft, type RunDraft } from '../../lib/ui/run-draft';

export type { SaveState };

const DEBOUNCE_MS = 800;

export function useRunAutosave(opts: {
  draftRef: RefObject<RunDraft | null>;
  runRef: RefObject<MissionRun | null>;
  setDraft: (d: RunDraft) => void;
  setRun: (r: MissionRun) => void;
  currentStepId: () => string | undefined;
}) {
  const { draftRef, runRef, setDraft, setRun, currentStepId } = opts;
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitDraft = useCallback((d: RunDraft) => {
    draftRef.current = d;
    saveDraft(d);
    setDraft(d);
  }, [draftRef, setDraft]);

  // One queue per runner instance; deps read refs so the queue always sees the newest draft and rev.
  const queueRef = useRef<ReturnType<typeof createSaveQueue> | null>(null);
  const depsRef = useRef({ commitDraft, setRun, currentStepId });
  depsRef.current = { commitDraft, setRun, currentStepId };
  queueRef.current ??= createSaveQueue({
    getDraft: () => draftRef.current,
    getRun: () => runRef.current,
    setDraft: (d) => depsRef.current.commitDraft(d),
    setRun: (r) => { runRef.current = r; depsRef.current.setRun(r); },
    currentStepId: () => depsRef.current.currentStepId(),
    save: (runId, input) => api.saveAnswers(runId, input),
    onState: setSaveState,
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
    commitDraft(d);
    cancelTimer();
    timer.current = setTimeout(() => void queue.flush(), DEBOUNCE_MS);
  }, [commitDraft, queue]);

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

  return { saveState, flush, settle, schedule, commitDraft };
}
