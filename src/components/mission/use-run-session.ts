/**
 * Runner state machine: load (open run, else the latest completed result, else a new run), edit answers
 * with autosave, reveal quiz/prediction answers on the server, submit with a stable idempotency key, map
 * the outcome to a phase the UI renders, and "Làm lại" (explicit new run of a completed mission).
 * Answer keys come only from the server (`answerKey`): revealed items, or all once the run is completed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LearnerMission } from '../../lib/learning/learner-mission-view';
import type { AnswerKey, Evaluation, MissionRun } from '../../lib/learning/types';
import { ApiError, api, friendlyMessage, type SubmitResponse } from '../../lib/ui/api-client';
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

export function useRunSession(missionId: string, fallbackMission: LearnerMission) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [mission, setMission] = useState<LearnerMission>(fallbackMission);
  const [run, setRunState] = useState<MissionRun | null>(null);
  const [draft, setDraftState] = useState<RunDraft | null>(null);
  const [stepIndex, setStepIndexState] = useState(0);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [answerKey, setAnswerKey] = useState<AnswerKey>({});
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

  const applyLoaded = useCallback((r: MissionRun, m: LearnerMission, ev: Evaluation | null, key: AnswerKey) => {
    setRun(r);
    setMission(m);
    setEvaluation(ev);
    setAnswerKey(key);
    const d = restoreDraft(r, loadDraft(r.id));
    draftRef.current = d;
    saveDraft(d);
    setDraftState(d);
    const idx = Math.max(0, m.steps.findIndex((s) => s.id === r.currentStep));
    stepRef.current = idx;
    setStepIndexState(idx);
    setPhase(phaseFor(r, ev));
  }, [setRun]);

  /** Opens the mission (`again`: start a new run even if it was completed) and loads the run detail. */
  const open = useCallback(async (again: boolean) => {
    const { run: started } = await api.startMission(missionId, { again });
    const detail = await api.getRun(started.id).catch(() => null);
    setResult(null);
    applyLoaded(detail?.run ?? started, detail?.mission ?? fallbackMission, detail?.evaluation ?? null, detail?.answerKey ?? {});
  }, [applyLoaded, fallbackMission, missionId]);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      await open(false);
    } catch (e) {
      setError(friendlyMessage(e));
      setPhase('load_error');
    }
  }, [open]);

  /** "Làm lại": a new run of a completed mission. Resolves to an error message, or null on success. */
  const startAgain = useCallback(async (): Promise<string | null> => {
    try {
      await open(true);
      return null;
    } catch (e) {
      return friendlyMessage(e);
    }
  }, [open]);

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
          setAnswerKey(d.answerKey);
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

  /**
   * Reveals one quiz question / prediction on the server after saving pending edits (the server only
   * reveals a saved answer and locks it). Resolves to an error message, or null on success.
   */
  const reveal = useCallback(async (stepId: string, itemId: string): Promise<string | null> => {
    const saved = await autosave.settle();
    const r = runRef.current;
    if (!saved || !r) return 'Chưa lưu được câu trả lời (có thể do mạng). Bạn thử lại sau giây lát nhé.';
    try {
      const res = await api.reveal(r.id, stepId, itemId);
      setRun(res.run);
      setAnswerKey((k) => ({ ...k, [`${stepId}:${itemId}`]: res.key }));
      return null;
    } catch (e) {
      const server = e instanceof ApiError && e.code === 'conflict' ? (e.body as { run?: unknown } | null)?.run : undefined;
      if (isRun(server)) {
        setRun(server);
        if (draftRef.current) autosave.commitDraft(mergeServerRun(draftRef.current, server));
        return 'Bài làm vừa được cập nhật. Bạn bấm lại một lần nữa nhé.';
      }
      return friendlyMessage(e);
    }
  }, [autosave, setRun]);

  /** Local-only draft changes (images, confidence, hints): mirrored to localStorage. */
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
      let res: SubmitResponse;
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
      setAnswerKey(res.answerKey ?? {});
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
    phase, setPhase, mission, run, draft, stepIndex, result, evaluation, answerKey, error,
    saveState: autosave.saveState, submitting, load, startAgain, goToStep, openReview, updateField, patchDraft, reveal, submit,
  };
}

export type RunSession = ReturnType<typeof useRunSession>;
