/**
 * The ai-tutor analyzer cron stage. ai-tutor is a server-side background analyzer: per debounced session
 * window it makes ONE structured LLM call through runAi (purpose 'insights', coaching budget pool). It is
 * not a Claude Code subagent, has no tools and no agent loop, and never calls GitHub, the ingest API or any
 * other service: the only network traffic is the model call itself.
 *
 * Per tick: sweep stale events → stop if the global daily quota is spent → for each ready window (at most
 * INSIGHTS_MAX_ANALYSES_PER_TICK model calls, budget checked before each): claim (lease) → pre-filters
 * (trivial / duplicate, no AI call) → quotas (learner spent → retry next UTC day 00:05; session spent →
 * skip) → model call (20 s timeout) → zod + evidence + hidden-reasoning checks → deterministic product gate
 * → atomic consent-guarded report write. A budget refusal from runAi defers the window without spending an
 * attempt and stops the stage (backpressure); any other failure retries with backoff, then dead-letters.
 */
import { AiUnavailableError, runAi } from '../coach/ai-gateway';
import { COACH_MODELS, WORKERS_AI_MODEL } from '../coach/ai-models';
import { newBoundary } from '../coach/untrusted-text';
import { listPublishedMissions } from '../content/loader';
import { newId, parseJson } from '../db/ids';
import type { CronBudget } from '../jobs/cron-budget';
import { buildAiTutorMessages, type PriorReportSummary } from './ai-tutor-prompt';
import { aiTutorJsonSchema, buildStoredReport, parseAiTutorReport, windowRefs } from './ai-tutor-report-schema';
import {
  claimWindow, completeWindow, deferWindow, failWindow, findReadyWindows, skipStaleEvents, skipWindow,
  type ClaimedWindow, type ReportRow,
} from './event-queue';
import { insightsRetentionDays } from './feature-flags';
import type { AiTutorReport, InsightSkipReason } from './insight-types';
import {
  analysesForSessionToday, analysesToday, analysesTodayGlobal, insightsQuotaCaps, nextUtcDayRetryAt, type InsightsQuotaCaps,
} from './insights-quotas';
import { filterWindow, type KeptEvent } from './turn-filters';

/** Model calls per cron tick at most. */
export const INSIGHTS_MAX_ANALYSES_PER_TICK = 8;
/** Windows looked at per tick (some end without a model call: filtered, quota, lost race). */
const WINDOWS_PER_TICK = INSIGHTS_MAX_ANALYSES_PER_TICK * 2;
/** The stage does not start (or continue) below these remaining budgets. */
export const MIN_SUBREQUESTS = 40;
export const MIN_REMAINING_MS = 30_000;
export const AI_TIMEOUT_MS = 20_000;
export const AI_MAX_TOKENS = 900;
export const AI_TEMPERATURE = 0.2;
/** Budget charged per window: claim, filters, quotas, prior report, runAi bookkeeping, write (~15 subrequests). */
export const WINDOW_COST = { d1: 12, net: 3 } as const;
/** How long a window waits after runAi refused for budget. */
export const BUDGET_DEFER_MS = 15 * 60_000;

export type AnalyzerStopReason = 'cron_budget' | 'global_quota' | 'ai_budget' | 'tick_cap';

export interface AnalyzerStageResult {
  /** Windows that produced a report. */
  analysed: number;
  /** Events skipped, by reason. */
  skipped: Partial<Record<InsightSkipReason, number>>;
  /** Windows deferred (quota or AI budget), without consuming an attempt. */
  deferred: number;
  /** Windows whose attempt failed and will be retried. */
  failed: number;
  /** Events moved to the dead-letter state. */
  dead: number;
  /** Windows whose learner revoked consent mid-flight (events deleted, no report). */
  revoked: number;
  /** Model calls made. */
  aiCalls: number;
  stopped?: AnalyzerStopReason;
}

export interface AnalyzerDeps {
  /** OpenRouter fetch (tests inject a mock). */
  fetchImpl?: typeof fetch;
}

const addSkip = (r: AnalyzerStageResult, reason: InsightSkipReason, n: number) => {
  if (n > 0) r.skipped[reason] = (r.skipped[reason] ?? 0) + n;
};

const canContinue = (budget: CronBudget): boolean =>
  budget.remainingSubrequests() >= MIN_SUBREQUESTS && budget.remainingMs() >= MIN_REMAINING_MS && budget.canAfford(WINDOW_COST);

/** Product observations survive only when the window touched the platform, and never as personal preference. */
export function gateProductObservation(report: AiTutorReport, platformTouch: boolean): AiTutorReport {
  const obs = report.product_observation;
  if (!obs) return report;
  if (!platformTouch || obs.category === 'personal_preference') return { ...report, product_observation: null };
  return report;
}

async function priorReport(db: D1Database, learnerId: string, sessionRef: string): Promise<PriorReportSummary | null> {
  const row = await db.prepare(`SELECT report_json FROM insight_reports WHERE learner_id = ? AND session_ref = ?
      ORDER BY created_at DESC LIMIT 1`).bind(learnerId, sessionRef).first<{ report_json: string }>();
  const r = parseJson<Partial<AiTutorReport> | null>(row?.report_json, null);
  if (!r?.intent_summary?.text) return null;
  return { intent_summary: r.intent_summary, next_best_action: r.next_best_action ?? null };
}

function reportRow(win: ClaimedWindow, kept: KeptEvent[], report: AiTutorReport, model: string, env: Env, now: Date): ReportRow {
  const byId = new Map(win.events.map((e) => [e.id, e]));
  const rows = kept.map((k) => byId.get(k.id)!);
  const createdAt = now.toISOString();
  const stored = buildStoredReport(report, { sourceRuntime: rows[0].source_runtime, createdAt, model });
  const lastPlatform = [...kept].reverse().map((k) => k.turn.platform).find((p) => p?.missionId || p?.runId);
  return {
    id: newId('irp'),
    learnerId: win.learnerId,
    sessionRef: win.sessionRef,
    missionId: lastPlatform?.missionId ?? null,
    runId: lastPlatform?.runId ?? null,
    reportJson: JSON.stringify(stored),
    intentSummary: report.intent_summary.text,
    skillsJson: JSON.stringify([...new Set(report.learning_insights.map((i) => i.skill))]),
    confidence: report.confidence,
    hasProductObservation: !!report.product_observation,
    sourceRuntime: stored.source_runtime,
    model,
    promptVersion: stored.prompt_version,
    eventCount: kept.length,
    windowStartedAt: rows[0].turn_ended_at,
    windowEndedAt: rows[rows.length - 1].turn_ended_at,
    createdAt,
    expiresAt: new Date(now.getTime() + insightsRetentionDays(env) * 86_400_000).toISOString(),
  };
}

type WindowOutcome = 'ai_called' | 'no_ai' | 'stop_ai_budget' | 'stop_global_quota';

async function processWindow(
  env: Env, win: ClaimedWindow, now: Date, caps: InsightsQuotaCaps, globalUsed: () => number,
  result: AnalyzerStageResult, deps: AnalyzerDeps,
): Promise<WindowOutcome> {
  const db = env.DB;
  const { kept, dropped, platformTouch } = filterWindow(win.events.map((e) => ({ id: e.id, payloadJson: e.payload_json })));
  for (const reason of ['trivial', 'duplicate', 'no_value'] as const) {
    const ids = dropped.filter((d) => d.reason === reason).map((d) => d.id);
    addSkip(result, reason, await skipWindow(db, win.leaseId, reason, now, ids));
  }
  if (kept.length === 0) return 'no_ai';

  if (globalUsed() >= caps.global) {
    await deferWindow(db, win.leaseId, nextUtcDayRetryAt(now));
    result.deferred += 1;
    return 'stop_global_quota';
  }
  if (await analysesToday(db, win.learnerId, now) >= caps.perLearner) {
    await deferWindow(db, win.leaseId, nextUtcDayRetryAt(now));
    result.deferred += 1;
    return 'no_ai';
  }
  if (await analysesForSessionToday(db, win.learnerId, win.sessionRef, now) >= caps.perSession) {
    addSkip(result, 'quota_session', await skipWindow(db, win.leaseId, 'quota_session', now));
    return 'no_ai';
  }

  const refs = windowRefs(kept.length);
  const missionIds = listPublishedMissions().map((m) => m.id);
  const missionSet = new Set(missionIds);
  const boundary = newBoundary();
  const messages = buildAiTutorMessages({
    events: kept.map((k, i) => ({ ref: refs[i], turnEndedAt: win.events.find((e) => e.id === k.id)!.turn_ended_at, turn: k.turn })),
    prior: await priorReport(db, win.learnerId, win.sessionRef),
    platformTouch,
    boundary,
  });

  result.aiCalls += 1;
  let report: AiTutorReport;
  let model: string;
  try {
    const ai = await runAi({ env, fetchImpl: deps.fetchImpl, now: () => now }, {
      purpose: 'insights',
      learnerId: win.learnerId,
      messages,
      maxTokens: AI_MAX_TOKENS,
      temperature: AI_TEMPERATURE,
      openRouterModels: COACH_MODELS,
      workersAiModel: WORKERS_AI_MODEL,
      jsonSchema: aiTutorJsonSchema(refs, missionIds),
      parse: (text) => parseAiTutorReport(text, { refs, missionIds: missionSet }),
      timeoutMs: AI_TIMEOUT_MS,
    });
    report = ai.value;
    model = ai.model;
  } catch (err) {
    if (err instanceof AiUnavailableError && err.reason === 'budget') {
      await deferWindow(db, win.leaseId, new Date(now.getTime() + BUDGET_DEFER_MS));
      result.deferred += 1;
      return 'stop_ai_budget';
    }
    await recordFailure(db, win.leaseId, err, now, result);
    return 'ai_called';
  }

  if (!report.relevant) {
    addSkip(result, 'not_learning', await skipWindow(db, win.leaseId, 'not_learning', now));
    return 'ai_called';
  }
  try {
    const row = reportRow(win, kept, gateProductObservation(report, platformTouch), model, env, now);
    const outcome = await completeWindow(db, win.leaseId, kept.map((k) => k.id), row, now);
    if (outcome === 'written') result.analysed += 1;
    else if (outcome === 'revoked') result.revoked += 1;
  } catch (err) {
    await recordFailure(db, win.leaseId, err, now, result);
  }
  return 'ai_called';
}

async function recordFailure(db: D1Database, leaseId: string, err: unknown, now: Date, result: AnalyzerStageResult): Promise<void> {
  console.warn('ai-tutor window failed', err instanceof Error ? err.message : err);
  const { retried, dead } = await failWindow(db, leaseId, err, now);
  if (retried > 0) result.failed += 1;
  result.dead += dead;
}

export async function runAnalyzerStage(env: Env, budget: CronBudget, now: Date, deps: AnalyzerDeps = {}): Promise<AnalyzerStageResult> {
  const result: AnalyzerStageResult = { analysed: 0, skipped: {}, deferred: 0, failed: 0, dead: 0, revoked: 0, aiCalls: 0 };
  if (!canContinue(budget)) return { ...result, stopped: 'cron_budget' };
  const db = env.DB;
  const caps = insightsQuotaCaps(env);

  budget.charge({ d1: 3 });
  addSkip(result, 'stale', await skipStaleEvents(db, now));
  let globalUsed = await analysesTodayGlobal(db, now);
  if (globalUsed >= caps.global) return { ...result, stopped: 'global_quota' };
  const windows = await findReadyWindows(db, now, WINDOWS_PER_TICK);

  for (const key of windows) {
    if (result.aiCalls >= INSIGHTS_MAX_ANALYSES_PER_TICK) return { ...result, stopped: 'tick_cap' };
    if (!canContinue(budget)) return { ...result, stopped: 'cron_budget' };
    budget.charge(WINDOW_COST);
    const win = await claimWindow(db, key, now);
    if (!win) continue;
    const calls = result.aiCalls;
    const outcome = await processWindow(env, win, now, caps, () => globalUsed, result, deps);
    if (result.aiCalls > calls) globalUsed += 1;
    if (outcome === 'stop_ai_budget') return { ...result, stopped: 'ai_budget' };
    if (outcome === 'stop_global_quota') return { ...result, stopped: 'global_quota' };
  }
  return result;
}
