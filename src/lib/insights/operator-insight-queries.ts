/**
 * Operator (/admin/insights) read layer for ai-tutor insights. The ONLY place admin pages and
 * /api/v1/admin/insights read insight data. Admin authorization and the feature flag are the caller's job;
 * consent is enforced here, inside every SQL statement (no cache, no separate check that could go stale):
 *
 * - Aggregates ("learning patterns") are counts only, over learners with `analysis = 1`, and every bucket
 *   is suppressed unless it covers at least COHORT_MIN distinct learners (k-anonymity).
 * - Product signals count only evidence from learners with `proposals = 1`, and only from reports written
 *   after that consent was (last) granted (`proposals_at`, as in the proposal pipeline), again with k ≥ COHORT_MIN;
 *   the signal title is the only text shown, and it is already de-identified by the proposal pipeline.
 * - Per-learner detail requires learners.observer_consent = 1 AND insight_consents.share_operator = 1 AND
 *   analysis = 1 (insightDetailJoin). Unknown, non-consenting and revoked learners are indistinguishable.
 *
 * No query here selects the queued turn payload column of insight_events (the redacted turn text):
 * operators never see raw transcripts. tests/unit/insights-operator-access.test.ts greps this file for the
 * column name to keep it that way.
 */
import { CONSENTED_LEARNER, consentJoin } from '../observer/consent-gate';
import { REPORT_VIEW_COLUMNS, toReportView, type InsightReportView, type ReportViewRow } from './learner-report-queries';

/** Smallest number of distinct learners an aggregate bucket or a signal must cover to be shown. */
export const COHORT_MIN = 3;
/** Learning patterns look at reports created in this many recent days. */
export const PATTERN_WINDOW_DAYS = 30;
const OPERATOR_REPORT_LIMIT = 50;
const DAY_MS = 86_400_000;
/** Turns become ready 5 min after arrival; a pending turn scheduled well past that was deferred by the budget. */
const DEFERRED_AFTER_DAYS = 6 / 1440;

/**
 * The per-learner detail gate as a JOIN fragment: observer consent (via consentJoin, alias `l`) plus the
 * insights share_operator and analysis consents (alias `ic`). Usage: `FROM insight_reports r ${insightDetailJoin('r')}`.
 */
export const insightDetailJoin = (alias: string): string =>
  `${consentJoin(alias)} AND l.merged_into IS NULL AND l.kind = 'member' JOIN insight_consents ic ON ic.learner_id = l.id AND ic.share_operator = 1 AND ic.analysis = 1`;

/** WHERE condition for queries over the learners table itself (aliases `l` and `ic`). */
const SHARING_LEARNER = `${CONSENTED_LEARNER} AND l.merged_into IS NULL AND l.kind = 'member' AND ic.share_operator = 1 AND ic.analysis = 1`;

// ---------- Pipeline health ----------

export interface HealthWindow {
  received: number;
  analysed: number;
  dead: number;
  skipped: Record<string, number>;
  /** Share of rated reports marked useful; null when nothing was rated. */
  usefulRate: number | null;
  rated: number;
}

export interface PipelineHealth {
  today: HealthWindow;
  week: HealthWindow;
  /** Current queue: waiting, being analysed, and waiting because the AI budget was spent. */
  pending: number;
  processing: number;
  budgetDeferred: number;
}

/** Start of the current day in Asia/Saigon (UTC+7, no DST) as an ISO instant. */
export function saigonDayStart(now: Date): string {
  const shifted = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 7 * 3_600_000).toISOString();
}

async function healthWindow(db: D1Database, since: string): Promise<HealthWindow> {
  // Independent reads (not db.batch, which is meant for writes): D1 runs them concurrently.
  const [e, skipped, r] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS received, SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
      FROM insight_events WHERE received_at >= ?`).bind(since).first<{ received: number; dead: number | null }>(),
    db.prepare(`SELECT COALESCE(skip_reason, 'unknown') AS reason, COUNT(*) AS n FROM insight_events
      WHERE status = 'skipped' AND received_at >= ? GROUP BY reason ORDER BY n DESC`).bind(since).all<{ reason: string; n: number }>(),
    db.prepare(`SELECT COUNT(*) AS analysed, SUM(CASE WHEN useful IS NOT NULL THEN 1 ELSE 0 END) AS rated,
      SUM(CASE WHEN useful = 1 THEN 1 ELSE 0 END) AS useful FROM insight_reports WHERE created_at >= ?`).bind(since)
      .first<{ analysed: number; rated: number | null; useful: number | null }>(),
  ]);
  const rated = Number(r?.rated ?? 0);
  return {
    received: Number(e?.received ?? 0),
    analysed: Number(r?.analysed ?? 0),
    dead: Number(e?.dead ?? 0),
    skipped: Object.fromEntries(skipped.results.map((s) => [s.reason, Number(s.n)])),
    usefulRate: rated > 0 ? Number(r?.useful ?? 0) / rated : null,
    rated,
  };
}

/** Counts only: today (Asia/Saigon) and the last 7 days, plus the current queue. */
export async function pipelineHealth(db: D1Database, now: Date = new Date()): Promise<PipelineHealth> {
  const queue = await db.prepare(
    `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
       SUM(CASE WHEN status = 'pending' AND attempts = 0 AND julianday(next_attempt_at) - julianday(received_at) > ? THEN 1 ELSE 0 END) AS deferred
     FROM insight_events WHERE status IN ('pending', 'processing')`,
  ).bind(DEFERRED_AFTER_DAYS).first<{ pending: number | null; processing: number | null; deferred: number | null }>();
  return {
    today: await healthWindow(db, saigonDayStart(now)),
    week: await healthWindow(db, new Date(now.getTime() - 7 * DAY_MS).toISOString()),
    pending: Number(queue?.pending ?? 0),
    processing: Number(queue?.processing ?? 0),
    budgetDeferred: Number(queue?.deferred ?? 0),
  };
}

// ---------- Learning patterns (k-anonymous counts) ----------

export interface CohortBucket { key: string; reports: number; learners: number }

export interface LearningPatterns {
  windowDays: number;
  /** Null when fewer than COHORT_MIN learners have reports in the window. */
  verificationGap: { reports: number; withGaps: number; learners: number } | null;
  skills: CohortBucket[];
  riskKinds: CohortBucket[];
  nextMissions: CohortBucket[];
  taskOutcomes: CohortBucket[];
}

/** Valid JSON or a harmless empty value, so one corrupt row can never abort an aggregate. */
const safeJson = (col: string, empty: string) => `CASE WHEN json_valid(${col}) THEN ${col} ELSE '${empty}' END`;

/** Unexpired reports in the window from live learners who currently have analysis consent. */
const CONSENTED_REPORTS = `WITH cr AS (
  SELECT r.id, r.learner_id, r.run_id, ${safeJson('r.report_json', '{}')} AS rj, ${safeJson('r.skills_json', '[]')} AS sj
  FROM insight_reports r
  JOIN insight_consents c ON c.learner_id = r.learner_id AND c.analysis = 1
  JOIN learners l ON l.id = r.learner_id AND l.deleted_at IS NULL
  WHERE r.created_at >= ? AND r.expires_at > ?)`;

const BUCKET_TAIL = `HAVING COUNT(DISTINCT cr.learner_id) >= ${COHORT_MIN} ORDER BY reports DESC, bucket_key ASC LIMIT 20`;

export async function learningPatterns(db: D1Database, now: Date = new Date()): Promise<LearningPatterns> {
  const since = new Date(now.getTime() - PATTERN_WINDOW_DAYS * DAY_MS).toISOString();
  const nowIso = now.toISOString();
  type BucketRow = { bucket_key: unknown; reports: number; learners: number };
  const bucket = (select: string) => db.prepare(`${CONSENTED_REPORTS} ${select} ${BUCKET_TAIL}`).bind(since, nowIso).all<BucketRow>();
  const [g, skills, risks, missions, outcomes] = await Promise.all([
    db.prepare(`${CONSENTED_REPORTS} SELECT COUNT(*) AS reports, COUNT(DISTINCT cr.learner_id) AS learners,
      SUM(CASE WHEN json_array_length(cr.rj, '$.verification_gaps') > 0 THEN 1 ELSE 0 END) AS with_gaps FROM cr`).bind(since, nowIso)
      .first<{ reports: number; learners: number; with_gaps: number | null }>(),
    bucket(`SELECT s.value AS bucket_key, COUNT(*) AS reports, COUNT(DISTINCT cr.learner_id) AS learners
      FROM cr, json_each(cr.sj) s WHERE s.type = 'text' GROUP BY s.value`),
    bucket(`SELECT json_extract(k.value, '$.kind') AS bucket_key, COUNT(DISTINCT cr.id) AS reports, COUNT(DISTINCT cr.learner_id) AS learners
      FROM cr, json_each(cr.rj, '$.risk_signals') k WHERE json_extract(k.value, '$.kind') IS NOT NULL GROUP BY bucket_key`),
    bucket(`SELECT json_extract(cr.rj, '$.next_best_action.mission_id') AS bucket_key, COUNT(*) AS reports, COUNT(DISTINCT cr.learner_id) AS learners
      FROM cr WHERE json_extract(cr.rj, '$.next_best_action.mission_id') IS NOT NULL GROUP BY bucket_key`),
    bucket(`SELECT m.status AS bucket_key, COUNT(*) AS reports, COUNT(DISTINCT cr.learner_id) AS learners
      FROM cr JOIN mission_runs m ON m.id = cr.run_id AND m.learner_id = cr.learner_id GROUP BY m.status`),
  ]);
  const toBuckets = (res: D1Result<BucketRow>): CohortBucket[] =>
    res.results
      .filter((b) => typeof b.bucket_key === 'string' && b.bucket_key !== '')
      .map((b) => ({ key: String(b.bucket_key), reports: Number(b.reports), learners: Number(b.learners) }));
  const gapLearners = Number(g?.learners ?? 0);
  return {
    windowDays: PATTERN_WINDOW_DAYS,
    verificationGap: gapLearners >= COHORT_MIN
      ? { reports: Number(g?.reports ?? 0), withGaps: Number(g?.with_gaps ?? 0), learners: gapLearners }
      : null,
    skills: toBuckets(skills),
    riskKinds: toBuckets(risks),
    nextMissions: toBuckets(missions),
    taskOutcomes: toBuckets(outcomes),
  };
}

// ---------- Product signals ----------

export interface ProductSignalRow {
  id: string;
  category: string;
  area: string;
  title: string;
  occurrences: number;
  affectedLearners: number;
  lastSeenAt: string;
  proposalStatus: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
}

/** Signals backed by evidence from at least COHORT_MIN distinct learners with `proposals` consent. */
export async function productSignals(db: D1Database): Promise<ProductSignalRow[]> {
  const rows = await db.prepare(
    `SELECT s.id, s.category, s.area, s.title, COUNT(*) AS occurrences, COUNT(DISTINCT r.learner_id) AS learners,
       MAX(e.created_at) AS last_seen, p.status AS proposal_status, p.github_issue_number, p.github_issue_url
     FROM insight_signals s
     JOIN insight_signal_evidence e ON e.signal_id = s.id
     JOIN insight_reports r ON r.id = e.report_id
     JOIN insight_consents c ON c.learner_id = r.learner_id AND c.proposals = 1
       AND c.proposals_at IS NOT NULL AND r.created_at >= c.proposals_at
     JOIN learners l ON l.id = r.learner_id AND l.deleted_at IS NULL
     LEFT JOIN insight_proposals p ON p.signal_id = s.id
     GROUP BY s.id
     HAVING COUNT(DISTINCT r.learner_id) >= ${COHORT_MIN}
     ORDER BY learners DESC, last_seen DESC LIMIT 50`,
  ).all<{
    id: string; category: string; area: string; title: string; occurrences: number; learners: number; last_seen: string;
    proposal_status: string | null; github_issue_number: number | null; github_issue_url: string | null;
  }>();
  return rows.results.map((r) => ({
    id: r.id, category: r.category, area: r.area, title: r.title, occurrences: Number(r.occurrences),
    affectedLearners: Number(r.learners), lastSeenAt: r.last_seen, proposalStatus: r.proposal_status,
    issueNumber: r.github_issue_number === null ? null : Number(r.github_issue_number), issueUrl: r.github_issue_url,
  }));
}

// ---------- Learners sharing detail ----------

export interface SharingLearner {
  id: string;
  displayName: string | null;
  sharedSince: string | null;
  reports: number;
  lastReportAt: string | null;
}

/** Learners who allow detail: observer_consent = 1 AND share_operator = 1 AND analysis = 1. */
export async function listSharingLearners(db: D1Database, now: Date = new Date()): Promise<SharingLearner[]> {
  const nowIso = now.toISOString();
  const rows = await db.prepare(
    `SELECT l.id, l.display_name, ic.share_operator_at,
       (SELECT COUNT(*) FROM insight_reports r WHERE r.learner_id = l.id AND r.expires_at > ?) AS reports,
       (SELECT MAX(created_at) FROM insight_reports r WHERE r.learner_id = l.id AND r.expires_at > ?) AS last_report
     FROM learners l JOIN insight_consents ic ON ic.learner_id = l.id
     WHERE ${SHARING_LEARNER}
     ORDER BY last_report IS NULL, last_report DESC LIMIT 200`,
  ).bind(nowIso, nowIso).all<{ id: string; display_name: string | null; share_operator_at: string | null; reports: number; last_report: string | null }>();
  return rows.results.map((r) => ({
    id: r.id, displayName: r.display_name, sharedSince: r.share_operator_at, reports: Number(r.reports), lastReportAt: r.last_report,
  }));
}

/** Gated learner lookup: null for unknown ids, guests, and learners without all three consents. */
export async function getSharingLearner(db: D1Database, learnerId: string): Promise<{ id: string; displayName: string | null; sharedSince: string | null } | null> {
  const row = await db.prepare(
    `SELECT l.id, l.display_name, ic.share_operator_at FROM learners l JOIN insight_consents ic ON ic.learner_id = l.id
     WHERE l.id = ? AND ${SHARING_LEARNER}`,
  ).bind(learnerId).first<{ id: string; display_name: string | null; share_operator_at: string | null }>();
  return row ? { id: row.id, displayName: row.display_name, sharedSince: row.share_operator_at } : null;
}

export interface OperatorLearnerReports {
  learner: { id: string; displayName: string | null; sharedSince: string | null };
  reports: InsightReportView[];
}

/**
 * One learner's newest reports for the operator, or null when the detail gate fails. The reports
 * statement carries the gate join itself, so a revoke between the two reads returns no reports.
 * Callers record the access (operator-access-audit.ts) before showing anything.
 */
export async function getLearnerReportsForOperator(db: D1Database, learnerId: string, now: Date = new Date()): Promise<OperatorLearnerReports | null> {
  const learner = await getSharingLearner(db, learnerId);
  if (!learner) return null;
  const rows = await db.prepare(
    `SELECT ${REPORT_VIEW_COLUMNS} FROM insight_reports r ${insightDetailJoin('r')}
     WHERE r.learner_id = ? AND r.expires_at > ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  ).bind(learnerId, now.toISOString(), OPERATOR_REPORT_LIMIT).all<ReportViewRow>();
  return { learner, reports: rows.results.map(toReportView) };
}

/** Everything /admin/insights shows, in one call. */
export async function operatorSummary(db: D1Database, now: Date = new Date()) {
  const [health, patterns, signals, sharingLearners] = await Promise.all([
    pipelineHealth(db, now), learningPatterns(db, now), productSignals(db), listSharingLearners(db, now),
  ]);
  return {
    health, patterns, signals, sharingLearners,
  };
}
export type OperatorSummary = Awaited<ReturnType<typeof operatorSummary>>;
