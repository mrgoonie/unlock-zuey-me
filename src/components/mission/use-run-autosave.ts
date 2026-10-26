/**
 * Debounced autosave of runner drafts to PATCH /api/v1/runs/:id/answers with optimistic locking.
 * - Every edit is mirrored to localStorage immediately (nothing is lost offline or on AI errors).
 * - On 409 the server run is adopted and unsaved local edits are re-applied on top, then saved again.
 * - Network failures keep the dirty flags; the next edit, step change or `online` event retries.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { MissionRun } from '../../lib/learning/types';
import { ApiError, api } from '../../lib/ui/api-client';
import { markSaved, mergeServerRun, saveDraft, type RunDraft } from '../../lib/ui/run-draft';

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline';

const DEBOUNCE_MS = 800;
const MAX_CONFLICT_RETRIES = 3;

const isRun = (v: unknown): v is MissionRun =>
  !!v && typeof v === 'object' && typeof (v as MissionRun).rev === 'number' && typeof (v as MissionRun).answers === 'object';

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
  const inFlight = useRef<Promise<boolean> | null>(null);

  const commitDraft = useCallback((d: RunDraft) => {
    draftRef.current = d;
    saveDraft(d);
    setDraft(d);
  }, [draftRef, setDraft]);

  /** Saves every dirty step (plus `forceStepId` to record the current step). Resolves true when all saved. */
  const flush = useCallback(async (forceStepId?: string): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inFlight.current) await inFlight.current.catch(() => false);
    const work = (async () => {
      let conflicts = 0;
      for (;;) {
        const draft = draftRef.current;
        const run = runRef.current;
        if (!draft || !run) return false;
        const stepIds = Object.keys(draft.dirty).filter((s) => draft.dirty[s]?.length);
        if (forceStepId && !stepIds.includes(forceStepId)) stepIds.push(forceStepId);
        if (!stepIds.length) return true;
        const stepId = stepIds[0];
        const sent = { ...(draft.answers[stepId] ?? {}) };
        setSaveState('saving');
        try {
          const res = await api.saveAnswers(run.id, { stepId, answers: sent, currentStep: currentStepId(), rev: run.rev });
          runRef.current = res.run;
          setRun(res.run);
          commitDraft(markSaved(draftRef.current ?? draft, stepId, sent));
          if (stepId === forceStepId) forceStepId = undefined;
        } catch (e) {
          if (e instanceof ApiError && e.code === 'conflict' && conflicts < MAX_CONFLICT_RETRIES) {
            const server = (e.body as { run?: unknown } | null)?.run;
            if (isRun(server)) {
              conflicts += 1;
              runRef.current = server;
              setRun(server);
              commitDraft(mergeServerRun(draftRef.current ?? draft, server));
              continue;
            }
          }
          setSaveState('offline');
          return false;
        }
        const after = draftRef.current;
        if (!forceStepId && after && !Object.values(after.dirty).some((f) => f.length)) {
          setSaveState('saved');
          return true;
        }
      }
    })();
    inFlight.current = work;
    try {
      return await work;
    } finally {
      if (inFlight.current === work) inFlight.current = null;
    }
  }, [commitDraft, currentStepId, draftRef, runRef, setRun]);

  /** Call after each local edit: persists locally now, saves to the server after a short pause. */
  const schedule = useCallback((d: RunDraft) => {
    commitDraft(d);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
  }, [commitDraft, flush]);

  useEffect(() => {
    const onOnline = () => void flush();
    const onHide = () => { if (document.visibilityState === 'hidden') void flush(); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onHide);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush]);

  return { saveState, flush, schedule, commitDraft };
}
