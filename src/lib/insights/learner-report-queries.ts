/**
 * Learner-side read/write layer for ai-tutor reports (/insights and /api/v1/insights/reports/**).
 *
 * Every statement is scoped `WHERE learner_id = ?` with the id taken from the session, never from the
 * request, so filters can only narrow a learner's own reports and another learner's id behaves exactly
 * like an unknown one (0 rows → 404). Expired reports (expires_at ≤ now) are invisible even before the
 * retention stage deletes them.
 *
 * `toReportView` is the learner-safe view of one report, shared with the operator drill-down so both show
 * the same fields. `product_observation` is deliberately dropped: it is an input to the operator proposal
 * pipeline. report_json is parsed defensively; a malformed column yields empty lists instead of throwing.
 */
import { parseJson } from '../db/ids';

export interface InsightReportView {
  id: string;
  createdAt: string;
  sessionRef: string;
  missionId: string | null;
  intent: { text: string; confidence: number };
  workflow: Array<{ step: string; ref: string }>;
  learning: Array<{ skill: string; note: string }>;
  gaps: Array<{ note: string; ref: string }>;
  risks: Array<{ kind: string; note: string; ref: string }>;
  next: { text: string; missionId?: string } | null;
  confidence: number;
  provenance: {
    sourceRuntime: string;
    model: string;
    promptVersion: number;
    eventCount: number;
    windowStartedAt: string;
    windowEndedAt: string;
  };
  useful: boolean | null;
}

/** Columns every report query selects (alias `r`). report_json is read only to build the view. */
export const REPORT_VIEW_COLUMNS = `r.id, r.created_at, r.session_ref, r.mission_id, r.report_json, r.intent_summary, r.confidence,
  r.source_runtime, r.model, r.prompt_version, r.event_count, r.useful, r.window_started_at, r.window_ended_at`;

export interface ReportViewRow {
  id: string; created_at: string; session_ref: string; mission_id: string | null; report_json: string;
  intent_summary: string; confidence: number; source_runtime: string; model: string; prompt_version: number;
  event_count: number; useful: number | null; window_started_at: string; window_ended_at: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

export function toReportView(row: ReportViewRow): InsightReportView {
  const r = parseJson<unknown>(row.report_json, {});
  const report: Obj = isObj(r) ? r : {};
  const intent = isObj(report.intent_summary) ? report.intent_summary : {};
  const next = isObj(report.next_best_action) ? report.next_best_action : null;
  const nextText = next ? str(next.text) : '';
  const nextMission = next ? str(next.mission_id) : '';
  return {
    id: row.id,
    createdAt: row.created_at,
    sessionRef: row.session_ref,
    missionId: row.mission_id,
    intent: { text: str(intent.text) || row.intent_summary, confidence: num(intent.confidence, num(row.confidence)) },
    workflow: list(report.workflow_observed).map((w) => ({ step: str(w.step), ref: str(w.evidence_ref) })).filter((w) => w.step),
    learning: list(report.learning_insights).map((l) => ({ skill: str(l.skill), note: str(l.note) })).filter((l) => l.note),
    gaps: list(report.verification_gaps).map((g) => ({ note: str(g.note), ref: str(g.evidence_ref) })).filter((g) => g.note),
    risks: list(report.risk_signals).map((k) => ({ kind: str(k.kind), note: str(k.note), ref: str(k.evidence_ref) })).filter((k) => k.note),
    next: nextText ? (nextMission ? { text: nextText, missionId: nextMission } : { text: nextText }) : null,
    confidence: num(row.confidence),
    provenance: {
      sourceRuntime: row.source_runtime,
      model: row.model,
      promptVersion: Number(row.prompt_version),
      eventCount: Number(row.event_count),
      windowStartedAt: row.window_started_at,
      windowEndedAt: row.window_ended_at,
    },
    useful: row.useful === null || row.useful === undefined ? null : Number(row.useful) === 1,
  };
}

export const REPORT_PAGE_SIZE = 20;
export const REPORT_PAGE_MAX = 50;
/** Vietnam has no DST, so a calendar day in Asia/Saigon is always [00:00+07:00, 24:00+07:00). */
const SAIGON_OFFSET = '+07:00';

export interface ReportFilters {
  cursor?: string | null;
  limit?: number;
  /** ISO instant, or a YYYY-MM-DD day (start of that day in Asia/Saigon). */
  from?: string | null;
  /** ISO instant, or a YYYY-MM-DD day (inclusive: up to the end of that day in Asia/Saigon). */
  to?: string | null;
  skill?: string | null;
  missionId?: string | null;
  sessionRef?: string | null;
}

export interface ReportPage { reports: InsightReportView[]; nextCursor: string | null }
export interface InsightSession { ref: string; label: string; lastAt: string }
export interface InsightQueueState { pending: number; lastReceivedAt: string | null }

/** Normalises a from/to bound to an ISO instant; null for empty input, undefined for malformed input. */
export function toInstant(raw: string | null | undefined, edge: 'start' | 'end'): string | null | undefined {
  if (!raw) return null;
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}${SAIGON_OFFSET}`
    : raw;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const encodeCursor = (r: { createdAt: string; id: string }) => btoa(`${r.createdAt}|${r.id}`);
function decodeCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = atob(cursor).split('|');
    return at && id ? { at, id } : null;
  } catch {
    return null;
  }
}

/** Newest-first page of the learner's own, unexpired reports (keyset on created_at, id). */
export async function listReports(db: D1Database, learnerId: string, f: ReportFilters = {}, now: Date = new Date()): Promise<ReportPage> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? REPORT_PAGE_SIZE), 1), REPORT_PAGE_MAX);
  const c = decodeCursor(f.cursor);
  const from = toInstant(f.from, 'start') ?? null;
  const to = toInstant(f.to, 'end') ?? null;
  const rows = await db.prepare(
    `SELECT ${REPORT_VIEW_COLUMNS} FROM insight_reports r
     WHERE r.learner_id = ? AND r.expires_at > ?
       AND (? IS NULL OR r.created_at >= ?) AND (? IS NULL OR r.created_at <= ?)
       AND (? IS NULL OR r.mission_id = ?) AND (? IS NULL OR r.session_ref = ?)
       AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(r.skills_json) s WHERE s.value = ?))
       AND (? IS NULL OR r.created_at < ? OR (r.created_at = ? AND r.id < ?))
     ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  ).bind(
    learnerId, now.toISOString(), from, from, to, to,
    f.missionId ?? null, f.missionId ?? null, f.sessionRef ?? null, f.sessionRef ?? null,
    f.skill ?? null, f.skill ?? null,
    c?.at ?? null, c?.at ?? null, c?.at ?? null, c?.id ?? null, limit + 1,
  ).all<ReportViewRow>();
  const reports = rows.results.slice(0, limit).map(toReportView);
  const last = reports[reports.length - 1];
  return { reports, nextCursor: rows.results.length > limit && last ? encodeCursor(last) : null };
}

const dayMonthParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Saigon', day: '2-digit', month: '2-digit' });
/** "26/10" in Asia/Saigon (vi-VN would render "26-10" for a day-month pair). */
function dayMonth(iso: string): string {
  const parts = dayMonthParts.formatToParts(new Date(iso));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('day')}/${pick('month')}`;
}

/** The learner's sessions that still have reports, newest first, numbered in the order they started. */
export async function listSessions(db: D1Database, learnerId: string, now: Date = new Date()): Promise<InsightSession[]> {
  const rows = await db.prepare(
    `SELECT session_ref, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM insight_reports
     WHERE learner_id = ? AND expires_at > ? GROUP BY session_ref ORDER BY first_at ASC, session_ref ASC`,
  ).bind(learnerId, now.toISOString()).all<{ session_ref: string; first_at: string; last_at: string }>();
  return rows.results
    .map((r, i) => ({ ref: r.session_ref, label: `Phiên ${i + 1} (${dayMonth(r.last_at)})`, lastAt: r.last_at }))
    .reverse()
    .slice(0, REPORT_PAGE_MAX);
}

/** Turns waiting for ai-tutor and the time the last turn arrived. */
export async function queueState(db: D1Database, learnerId: string): Promise<InsightQueueState> {
  const row = await db.prepare(
    `SELECT SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS pending, MAX(received_at) AS last_received
     FROM insight_events WHERE learner_id = ?`,
  ).bind(learnerId).first<{ pending: number | null; last_received: string | null }>();
  return { pending: Number(row?.pending ?? 0), lastReceivedAt: row?.last_received ?? null };
}

/** Deletes one of the learner's reports (signal evidence cascades). False when it is not theirs or unknown. */
export async function deleteReport(db: D1Database, learnerId: string, reportId: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM insight_reports WHERE id = ? AND learner_id = ?').bind(reportId, learnerId).run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Deletes every report of the learner and the turns still waiting in the queue (pending or being
 * processed), so nothing already sent turns into a new report afterwards. Returns the reports deleted.
 */
export async function deleteAllReports(db: D1Database, learnerId: string): Promise<number> {
  const [reports] = await db.batch([
    db.prepare('DELETE FROM insight_reports WHERE learner_id = ?').bind(learnerId),
    db.prepare(`DELETE FROM insight_events WHERE learner_id = ? AND status IN ('pending', 'processing')`).bind(learnerId),
  ]);
  return reports?.meta.changes ?? 0;
}

/** Records "Hữu ích" / "Không hữu ích" on the learner's own report. False when it is not theirs or unknown. */
export async function setUseful(db: D1Database, learnerId: string, reportId: string, useful: boolean, now: Date = new Date()): Promise<boolean> {
  const r = await db.prepare('UPDATE insight_reports SET useful = ? WHERE id = ? AND learner_id = ? AND expires_at > ?')
    .bind(useful ? 1 : 0, reportId, learnerId, now.toISOString()).run();
  return (r.meta.changes ?? 0) > 0;
}
