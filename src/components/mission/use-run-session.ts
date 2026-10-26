/**
 * Runner state machine: load (start/resume run), edit answers with autosave, submit with a stable
 * idempotency key, and map the outcome to a phase the UI renders.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Mission } from '../../lib/content/schema';
import type { Evaluation, MissionRun, SubmitResult } from '../../lib/learning/types';
import { ApiError, api, friendlyMessage } from '../../lib/ui/api-client';
import { isRun } from '../../lib/ui/autosave-queue';
import {
  clearAttempt, ensureAttemptKey, loadDraft, mergeServerRun, removeDraft, restoreDraft, saveDraft, setField, type AnswerValue, type RunDraft,
} from '../../lib/ui/run-draft';
import { useRunAutosave } from './use-run-autosave';

export type Phase = 'loading' | 'load_error' | 'steps' | 'review' | 'evaluating' | 'needs_revision' | 'evaluation_failed' | 'passed';

const POLL_MS = 3000;
const POLL_MAX = 40;

function phaseFor(run: MissionRun, evaluation: Evaluation | null): Phase {
  if (run.status === 'evaluating') return 'evaluating';
  if (run.status === 'evaluation_failed') return 'evaluation_failed';
  if (run.status === 'needs_revision' && evaluation) return 'needs_revision';
  if (run.status === 'completed' && evaluation?.status === 'passed') return 'passed';
  return 'steps';
}

export function useRunSession(missionId: string, fallbackMission: Mission) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [mission, setMission] = useState<Mission>(fallbackMission);
  const [run, setRunState] = useState<MissionRun | null>(null);
  const [draft, setDraftState] = useState<RunDraft | null>(null);
  const [stepIndex, setStepIndexState] = useState(0);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const runRef = useRef<MissionRun | null>(null);
  const draftRef = useRef<RunDraft | null>(null);
  const stepRef = useRef(0);
  const missionRef = useRef(mission);
  missionRef.current = mission;

  const setRun = useCallback((r: MissionRun) => { runRef.current = r; setRunState(r); }, []);
  const currentStepId = useCallback(() => missionRef.current.steps[stepRef.current]?.id, []);
  const autosave = useRunAutosave({ draftRef, runRef, setDraft: setDraftState, setRun, currentStepId });

  const applyLoaded = useCallback((r: MissionRun, m: Mission, ev: Evaluation | null) => {
    setRun(r);
    setMission(m);
    setEvaluation(ev);
    const d = restoreDraft(r, loadDraft(r.id));
    draftRef.current = d;
    saveDraft(d);
    setDraftState(d);
    const idx = Math.max(0, m.steps.findIndex((s) => s.id === r.currentStep));
    stepRef.current = idx;
    setStepIndexState(idx);
    setPhase(phaseFor(r, ev));
  }, [setRun]);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const { run: started } = await api.startMission(missionId);
      const detail = await api.getRun(started.id).catch(() => null);
      applyLoaded(detail?.run ?? started, detail?.mission ?? fallbackMission, detail?.evaluation ?? null);
    } catch (e) {
      setError(friendlyMessage(e));
      setPhase('load_error');
    }
  }, [applyLoaded, fallbackMission, missionId]);

  useEffect(() => { void load(); }, [load]);

  // A reload during grading lands in "evaluating": poll until the server has an outcome.
  useEffect(() => {
    if (phase !== 'evaluating' || submitting || result || !run) return;
    let tries = 0;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      tries += 1;
      try {
        const d = await api.getRun(run.id);
        if (d.run.status !== 'evaluating') {
          setRun(d.run);
          setEvaluation(d.evaluation);
          setPhase(phaseFor(d.run, d.evaluation));
          return;
        }
      } catch { /* keep waiting */ }
      if (tries < POLL_MAX) setTimeout(tick, POLL_MS);
      else setPhase('evaluation_failed');
    };
    const t = setTimeout(tick, POLL_MS);
    return () => { stop = true; clearTimeout(t); };
  }, [phase, submitting, result, run, setRun]);

  const goToStep = useCallback((i: number) => {
    const max = missionRef.current.steps.length - 1;
    const idx = Math.max(0, Math.min(max, i));
    stepRef.current = idx;
    setStepIndexState(idx);
    setPhase('steps');
    void autosave.flush(missionRef.current.steps[idx]?.id);
  }, [autosave]);

  const openReview = useCallback(() => {
    setPhase('review');
    void autosave.flush(missionRef.current.steps[stepRef.current]?.id);
  }, [autosave]);

  const updateField = useCallback((stepId: string, fieldId: string, value: AnswerValue) => {
    const d = draftRef.current;
    if (d) autosave.schedule(setField(d, stepId, fieldId, value));
  }, [autosave]);

  /** Local-only draft changes (images, confidence, hints, reveals): mirrored to localStorage. */
  const patchDraft = useCallback((fn: (d: RunDraft) => RunDraft) => {
    const d = draftRef.current;
    if (d) autosave.commitDraft(fn(d));
  }, [autosave]);

  const submittingRef = useRef(false);
  /** Submits the saved answers. Guarded against double taps; every failure path keeps the draft. */
  async function submit() {
    const r = runRef.current;
    if (!r || !draftRef.current || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await submitOnce(r);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /** Sends one submit with `key`. Throws ApiError on failure. */
  const sendSubmit = (runId: string, key: string, d: RunDraft) => api.submit(runId, {
    idempotencyKey: key,
    confidence: d.confidence ?? undefined,
    imageKeys: d.imageKeys.length ? d.imageKeys : undefined,
  });

  async function submitOnce(r: MissionRun) {
    setError(null);
    setResult(null);
    setPhase('evaluating');
    // Wait for every queued/in-flight autosave: a PATCH racing the submit would bump rev and fail the claim.
    const saved = await autosave.settle();
    if (!saved || !draftRef.current) {
      setError('Chưa lưu được bài lên máy chủ (có thể do mạng). Bài vẫn nằm trên máy này, hãy thử nộp lại.');
      setPhase('evaluation_failed');
      return;
    }
    const keyed = ensureAttemptKey(draftRef.current);
    autosave.commitDraft(keyed);
    const key = keyed.attempt!.key;
    try {
      let res: SubmitResult;
      try {
        res = await sendSubmit(r.id, key, keyed);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'conflict')) throw e;
        // The run changed under us (concurrent save or another tab). Adopt it, save, retry once, same key.
        const server = (e.body as { run?: unknown } | null)?.run;
        if (isRun(server)) {
          setRun(server);
          if (server.status === 'evaluating') return; // already being graded: the poller picks up the outcome
          autosave.commitDraft(mergeServerRun(draftRef.current ?? keyed, server));
        }
        const again = await autosave.settle();
        if (!again) throw e;
        res = await sendSubmit(r.id, key, draftRef.current ?? keyed);
      }
      setRun(res.run);
      setResult(res);
      setEvaluation(res.evaluation);
      if (res.evaluation.status === 'failed' || res.run.status === 'evaluation_failed') {
        setPhase('evaluation_failed');
        return;
      }
      autosave.commitDraft(clearAttempt(draftRef.current ?? keyed));
      if (res.evaluation.status === 'passed') {
        removeDraft(r.id);
        setPhase('passed');
      } else setPhase('needs_revision');
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'invalid' || e.code === 'conflict')) {
        // A conflict is never a grading failure: send the learner back to submit again calmly.
        setError(e.code === 'conflict' ? 'Bài làm vừa được cập nhật. Mình đã tải bản mới nhất, bạn bấm nộp lại nhé.' : e.message);
        setPhase('review');
        return;
      }
      setError(friendlyMessage(e));
      setPhase('evaluation_failed');
    }
  }

  return {
    phase, setPhase, mission, run, draft, stepIndex, result, evaluation, error,
    saveState: autosave.saveState, submitting, load, goToStep, openReview, updateField, patchDraft, submit,
  };
}

export type RunSession = ReturnType<typeof useRunSession>;
