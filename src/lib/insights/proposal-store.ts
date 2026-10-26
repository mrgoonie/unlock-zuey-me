/**
 * D1 access for the proposal pipeline: signals, evidence, cohort statistics, proposals and their triage
 * transitions, the filing lease, the daily issue counter, and the stage cursors.
 *
 * Privacy invariants enforced in SQL here, never in callers:
 * - Evidence counts only while the report's learner has `proposals = 1`, the report was created at or after
 *   `proposals_at`, and the learner is not deleted. Revoking consent therefore drops the learner from every
 *   cohort at the next read. Deleting reports cascades their evidence rows (FK).
 * - Signals and proposals carry no learner column; nothing here returns a learner id or name.
 */
import { parseJson } from '../db/ids';
import { CONSENT_SQL } from './consent-store';
import { utcDay } from '../learning/learner-day';
import type { GateDecision, ProposalStatus, RiskLevel, SignalCategory } from './insight-types';
import { readSetting, SYSTEM_ACTOR, writeSettingStatement } from './operator-settings';

/** Evidence window of cohort statistics, the gate and the issue body ("14 days"). */
export const SIGNAL_WINDOW_DAYS = 14;
/** A filing lease; an expired lease (crash mid-filing) lets the next attempt take over. */
export const FILING_LEASE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

export const daysBefore = (now: Date, days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();

export interface SignalRow {
  id: string;
  fingerprint: string;
  category: SignalCategory;
  area: string;
  title: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ProposalRow {
  id: string;
  signal_id: string;
  status: ProposalStatus;
  risk: RiskLevel;
  gate_json: string;
  draft_json: string;
  duplicate_of: string | null;
  ai_handle: number;
  ai_handle_approved_by: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  filing_lease_until: string | null;
  shipped_ref: string | null;
  shipped_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CohortStats {
  /** Distinct consenting learners. */
  learners: number;
  /** Evidence rows (reports). */
  occurrences: number;
  /** Average evidence confidence, 0 when there is none. */
  avgConfidence: number;
}

/** Joins that keep only evidence from consenting, non-deleted learners (see file header). */
const CONSENTED_EVIDENCE = `FROM insight_signal_evidence e
  JOIN insight_reports r ON r.id = e.report_id
  JOIN insight_consents ic ON ic.learner_id = r.learner_id AND ${CONSENT_SQL.proposalsConsented('r')}
    AND ic.proposals_at IS NOT NULL AND r.created_at >= ic.proposals_at
  JOIN learners l ON l.id = r.learner_id AND l.deleted_at IS NULL`;

const toStats = (row: { learners?: number | null; occurrences?: number | null; avg_confidence?: number | null } | null): CohortStats => ({
  learners: Number(row?.learners ?? 0),
  occurrences: Number(row?.occurrences ?? 0),
  avgConfidence: Math.round(Number(row?.avg_confidence ?? 0) * 1000) / 1000,
});

// ---------------------------------------------------------------------------------------------------------
// Signals and evidence

export interface SignalLink {
  fingerprint: string;
  category: SignalCategory;
  area: string;
  title: string;
  reportId: string;
  abstractEvidence: string;
  confidence: number;
  /** When the observation happened (the report's created_at). */
  evidenceAt: string;
}

/** Upserts the signal (fingerprint is unique) and links the report as evidence, idempotently, in one batch. */
export function linkEvidenceStatements(db: D1Database, link: SignalLink, signalId: string, now: Date): D1PreparedStatement[] {
  const at = now.toISOString();
  return [
    db.prepare(`INSERT INTO insight_signals (id, fingerprint, category, area, title, first_seen_at, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
      .bind(signalId, link.fingerprint, link.category, link.area, link.title, link.evidenceAt, at, at),
    db.prepare(`INSERT OR IGNORE INTO insight_signal_evidence (signal_id, report_id, abstract_evidence, confidence, created_at)
      SELECT id, ?, ?, ?, ? FROM insight_signals WHERE fingerprint = ?`)
      .bind(link.reportId, link.abstractEvidence, Math.min(1, Math.max(0, link.confidence)), link.evidenceAt, link.fingerprint),
  ];
}

export async function cohortStats(db: D1Database, signalId: string, since: string, until = '9999-12-31T00:00:00.000Z'): Promise<CohortStats> {
  const row = await db.prepare(`SELECT COUNT(DISTINCT r.learner_id) AS learners, COUNT(*) AS occurrences, AVG(e.confidence) AS avg_confidence
    ${CONSENTED_EVIDENCE} WHERE e.signal_id = ? AND e.created_at >= ? AND e.created_at < ?`).bind(signalId, since, until).first();
  return toStats(row as never);
}

/** Cohort statistics of many signals in one query (dashboard list). */
export async function cohortStatsBySignal(db: D1Database, since: string): Promise<Map<string, CohortStats>> {
  const r = await db.prepare(`SELECT e.signal_id AS signal_id, COUNT(DISTINCT r.learner_id) AS learners, COUNT(*) AS occurrences,
      AVG(e.confidence) AS avg_confidence ${CONSENTED_EVIDENCE} WHERE e.created_at >= ? GROUP BY e.signal_id`).bind(since).all();
  return new Map(r.results.map((row) => [String((row as { signal_id: string }).signal_id), toStats(row as never)]));
}

/** Up to `limit` abstract evidence texts (newest first) from consenting learners, for the draft. */
export async function consentedEvidence(db: D1Database, signalId: string, since: string, limit = 5): Promise<string[]> {
  const r = await db.prepare(`SELECT e.abstract_evidence AS text ${CONSENTED_EVIDENCE}
    WHERE e.signal_id = ? AND e.created_at >= ? ORDER BY e.created_at DESC LIMIT ?`).bind(signalId, since, limit).all<{ text: string }>();
  return r.results.map((x) => x.text);
}

/**
 * Display names of the learners behind a signal's evidence (all of it, consented or not). Used only as a
 * deny-list for the privacy check of the issue body; never stored or returned.
 */
export async function contributorNames(db: D1Database, signalId: string): Promise<string[]> {
  const r = await db.prepare(`SELECT DISTINCT l.display_name AS name FROM insight_signal_evidence e
    JOIN insight_reports r ON r.id = e.report_id JOIN learners l ON l.id = r.learner_id
    WHERE e.signal_id = ? AND l.display_name IS NOT NULL`).bind(signalId).all<{ name: string }>();
  return r.results.map((x) => x.name);
}

export async function getSignal(db: D1Database, id: string): Promise<SignalRow | null> {
  return db.prepare(`SELECT id, fingerprint, category, area, title, first_seen_at, last_seen_at FROM insight_signals WHERE id = ?`)
    .bind(id).first<SignalRow>();
}

// ---------------------------------------------------------------------------------------------------------
// Proposals

export interface NewProposal {
  id: string;
  signalId: string;
  gate: GateDecision;
  draftJson: string;
  aiHandle: boolean;
}

/** One proposal per signal (`signal_id UNIQUE`): returns false when the signal already has one. */
export async function createProposal(db: D1Database, p: NewProposal, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const r = await db.prepare(`INSERT OR IGNORE INTO insight_proposals (id, signal_id, status, risk, gate_json, draft_json, ai_handle, created_at, updated_at)
    VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`)
    .bind(p.id, p.signalId, p.gate.risk, JSON.stringify(p.gate), p.draftJson, p.aiHandle ? 1 : 0, at, at).run();
  return (r.meta.changes ?? 0) === 1;
}

/** Re-evaluated gate of a proposal still awaiting triage. */
export async function updateProposalGate(db: D1Database, id: string, gate: GateDecision, now: Date): Promise<void> {
  await db.prepare(`UPDATE insight_proposals SET risk = ?, gate_json = ?, updated_at = ? WHERE id = ? AND status IN ('proposed', 'accepted')`)
    .bind(gate.risk, JSON.stringify(gate), now.toISOString(), id).run();
}

export async function updateProposalDraft(db: D1Database, id: string, draftJson: string, now: Date): Promise<void> {
  await db.prepare(`UPDATE insight_proposals SET draft_json = ?, updated_at = ? WHERE id = ?`).bind(draftJson, now.toISOString(), id).run();
}

export async function getProposal(db: D1Database, id: string): Promise<ProposalRow | null> {
  return db.prepare(`SELECT * FROM insight_proposals WHERE id = ?`).bind(id).first<ProposalRow>();
}

export const proposalGate = (p: Pick<ProposalRow, 'gate_json' | 'risk'>): GateDecision =>
  parseJson<GateDecision>(p.gate_json, { decision: 'none', risk: p.risk, reasons: [] });

/** Triage actions that are plain status changes (filing and ai-handle approval have their own paths). */
export type TriageAction = 'accept' | 'reject' | 'mark_duplicate' | 'mark_shipped' | 'reopen';

export const TRIAGE_TRANSITIONS: Record<TriageAction, { from: readonly ProposalStatus[]; to: ProposalStatus }> = {
  accept: { from: ['proposed'], to: 'accepted' },
  reject: { from: ['proposed', 'accepted'], to: 'rejected' },
  mark_duplicate: { from: ['proposed', 'accepted'], to: 'duplicate' },
  // `accepted` too: a change shipped by hand without a GitHub issue.
  mark_shipped: { from: ['accepted', 'issue_filed'], to: 'shipped' },
  reopen: { from: ['rejected', 'duplicate'], to: 'proposed' },
};

/** Guarded status change; false when the proposal is missing or not in an allowed source status. */
export async function applyTriage(
  db: D1Database, id: string, action: TriageAction, opts: { actor: string; now: Date; duplicateOf?: string; shippedRef?: string },
): Promise<boolean> {
  const t = TRIAGE_TRANSITIONS[action];
  const at = opts.now.toISOString();
  const from = t.from.map(() => '?').join(', ');
  const extra = action === 'mark_duplicate' ? ', duplicate_of = ?'
    : action === 'mark_shipped' ? ', shipped_ref = ?, shipped_at = ?'
      : action === 'reopen' ? ', duplicate_of = NULL' : '';
  const extraBinds = action === 'mark_duplicate' ? [opts.duplicateOf ?? null]
    : action === 'mark_shipped' ? [opts.shippedRef ?? null, at] : [];
  const r = await db.prepare(`UPDATE insight_proposals SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?${extra}
    WHERE id = ? AND status IN (${from})`)
    .bind(t.to, opts.actor, at, at, ...extraBinds, id, ...t.from).run();
  return (r.meta.changes ?? 0) === 1;
}

/** Records an operator's explicit ai-handle approval (only before rejection or duplication). */
export async function approveAiHandle(db: D1Database, id: string, adminId: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const r = await db.prepare(`UPDATE insight_proposals SET ai_handle_approved_by = ?, updated_at = ?
    WHERE id = ? AND status IN ('proposed', 'accepted', 'issue_filed')`).bind(adminId, at, id).run();
  return (r.meta.changes ?? 0) === 1;
}

export async function setAiHandleLabelled(db: D1Database, id: string, now: Date): Promise<void> {
  await db.prepare(`UPDATE insight_proposals SET ai_handle = 1, updated_at = ? WHERE id = ?`).bind(now.toISOString(), id).run();
}

// ---------------------------------------------------------------------------------------------------------
// Filing lease

export const FILEABLE_STATUSES: readonly ProposalStatus[] = ['proposed', 'accepted', 'filing'];

/**
 * Takes the filing lease. Exactly one concurrent caller wins (single guarded UPDATE); an expired lease from
 * a crashed attempt can be taken over. Never succeeds once an issue number is recorded.
 */
export async function leaseForFiling(db: D1Database, id: string, now: Date, leaseMs = FILING_LEASE_MS): Promise<boolean> {
  const at = now.toISOString();
  const r = await db.prepare(`UPDATE insight_proposals SET status = 'filing', filing_lease_until = ?, updated_at = ?
    WHERE id = ? AND status IN ('proposed', 'accepted', 'filing') AND github_issue_number IS NULL
      AND (filing_lease_until IS NULL OR filing_lease_until < ?)`)
    .bind(new Date(now.getTime() + leaseMs).toISOString(), at, id, at).run();
  return (r.meta.changes ?? 0) === 1;
}

/** Gives the lease back after a failed attempt; the proposal returns to its prior status. */
export async function releaseFiling(db: D1Database, id: string, prior: ProposalStatus, now: Date): Promise<void> {
  const back = prior === 'filing' ? 'accepted' : prior;
  await db.prepare(`UPDATE insight_proposals SET status = ?, filing_lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'filing'`)
    .bind(back, now.toISOString(), id).run();
}

export async function recordFiled(
  db: D1Database, id: string, issue: { number: number; url: string; aiHandle: boolean }, actor: string, now: Date,
): Promise<void> {
  const at = now.toISOString();
  await db.prepare(`UPDATE insight_proposals SET status = 'issue_filed', github_issue_number = ?, github_issue_url = ?, ai_handle = ?,
      filing_lease_until = NULL, decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, ?), updated_at = ?
    WHERE id = ? AND status = 'filing'`)
    .bind(issue.number, issue.url, issue.aiHandle ? 1 : 0, actor, at, at, id).run();
}

/** The fingerprint already has an issue closed inside the cooldown: the proposal becomes a duplicate. */
export async function recordDuplicateOfIssue(db: D1Database, id: string, issueUrl: string, now: Date): Promise<void> {
  const at = now.toISOString();
  await db.prepare(`UPDATE insight_proposals SET status = 'duplicate', duplicate_of = ?, filing_lease_until = NULL,
      decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'filing'`)
    .bind(issueUrl, SYSTEM_ACTOR, at, at, id).run();
}

// ---------------------------------------------------------------------------------------------------------
// Daily issue counter (per UTC day), reserved atomically before a create so concurrent filings cannot exceed it

const issueCounterKey = (now: Date) => `issues_filed:${utcDay(now)}`;

export async function issuesFiledToday(db: D1Database, now: Date): Promise<number> {
  return Number((await readSetting(db, issueCounterKey(now))) ?? 0) || 0;
}

/** Reserves one of today's issue slots; false once `cap` issues were filed (or reserved) today. */
export async function reserveIssueSlot(db: D1Database, now: Date, cap: number): Promise<boolean> {
  if (cap < 1) return false;
  const r = await db.prepare(`INSERT INTO insight_operator_settings (key, value, updated_by, updated_at) VALUES (?, '1', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(insight_operator_settings.value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at
    WHERE CAST(insight_operator_settings.value AS INTEGER) < ?`)
    .bind(issueCounterKey(now), SYSTEM_ACTOR, now.toISOString(), cap).run();
  return (r.meta.changes ?? 0) === 1;
}

/** Returns a reserved slot when the create did not happen. */
export async function releaseIssueSlot(db: D1Database, now: Date): Promise<void> {
  await db.prepare(`UPDATE insight_operator_settings SET value = CAST(MAX(0, CAST(value AS INTEGER) - 1) AS TEXT) WHERE key = ?`)
    .bind(issueCounterKey(now)).run();
}

/** Drops counters of past days. */
export async function pruneIssueCounters(db: D1Database, now: Date): Promise<void> {
  await db.prepare(`DELETE FROM insight_operator_settings WHERE key LIKE 'issues_filed:%' AND key < ?`).bind(issueCounterKey(now)).run();
}

// ---------------------------------------------------------------------------------------------------------
// Stage cursors: (timestamp, id) positions so every tick resumes exactly where the last one stopped

export interface StageCursor {
  at: string;
  id: string;
}
export const REPORT_CURSOR_KEY = 'proposal_stage:report_cursor';
export const SIGNAL_CURSOR_KEY = 'proposal_stage:signal_cursor';
const START: StageCursor = { at: '', id: '' };

export async function readCursor(db: D1Database, key: string): Promise<StageCursor> {
  const c = parseJson<Partial<StageCursor>>(await readSetting(db, key), START);
  return typeof c.at === 'string' && typeof c.id === 'string' ? { at: c.at, id: c.id } : START;
}

export const writeCursorStatement = (db: D1Database, key: string, c: StageCursor, now: Date): D1PreparedStatement =>
  writeSettingStatement(db, key, JSON.stringify(c), SYSTEM_ACTOR, now);

// ---------------------------------------------------------------------------------------------------------
// Post-ship monitoring

/** Filed issues to re-check, least recently checked first. */
export async function filedProposalsToCheck(db: D1Database, limit: number): Promise<Array<{ id: string; github_issue_number: number }>> {
  const r = await db.prepare(`SELECT id, github_issue_number FROM insight_proposals
    WHERE status = 'issue_filed' AND github_issue_number IS NOT NULL ORDER BY updated_at, id LIMIT ?`)
    .bind(limit).all<{ id: string; github_issue_number: number }>();
  return r.results;
}

/** Applies a GitHub issue state: closed as completed → shipped, closed as not planned → rejected, open → touched. */
export async function applyIssueState(
  db: D1Database, id: string, issue: { state: 'open' | 'closed'; closedAt: string | null; stateReason: string | null; url: string }, now: Date,
): Promise<'shipped' | 'rejected' | 'open'> {
  const at = now.toISOString();
  if (issue.state === 'closed' && issue.stateReason === 'not_planned') {
    await db.prepare(`UPDATE insight_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ?
      WHERE id = ? AND status = 'issue_filed'`).bind(SYSTEM_ACTOR, at, at, id).run();
    return 'rejected';
  }
  if (issue.state === 'closed') {
    await db.prepare(`UPDATE insight_proposals SET status = 'shipped', shipped_ref = COALESCE(shipped_ref, ?), shipped_at = ?, updated_at = ?
      WHERE id = ? AND status = 'issue_filed'`).bind(issue.url, issue.closedAt ?? at, at, id).run();
    return 'shipped';
  }
  await db.prepare(`UPDATE insight_proposals SET updated_at = ? WHERE id = ?`).bind(at, id).run();
  return 'open';
}

/** Days after shipping over which the signal's occurrences are compared with the days before. */
export const MONITOR_WINDOW_DAYS = 14;

/** Shipped proposals whose after-window has elapsed become `monitored`. */
export async function promoteMonitored(db: D1Database, now: Date): Promise<number> {
  const r = await db.prepare(`UPDATE insight_proposals SET status = 'monitored', updated_at = ? WHERE status = 'shipped' AND shipped_at <= ?`)
    .bind(now.toISOString(), daysBefore(now, MONITOR_WINDOW_DAYS)).run();
  return r.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------------------------------------
// Dashboard views (no learner data: counts only)

export interface ProposalListRow extends ProposalRow {
  fingerprint: string;
  category: SignalCategory;
  area: string;
  title: string;
}

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'proposed', 'duplicate', 'accepted', 'rejected', 'filing', 'issue_filed', 'shipped', 'monitored',
];

export async function listProposals(db: D1Database, status: ProposalStatus | null, limit = 200): Promise<ProposalListRow[]> {
  const r = await db.prepare(`SELECT p.*, s.fingerprint, s.category, s.area, s.title FROM insight_proposals p
    JOIN insight_signals s ON s.id = p.signal_id ${status ? 'WHERE p.status = ?' : ''} ORDER BY p.updated_at DESC LIMIT ?`)
    .bind(...(status ? [status, limit] : [limit])).all<ProposalListRow>();
  return r.results;
}

/** Dashboard shape of a proposal (admin only; aggregates, never learner data). */
export interface ProposalSummary {
  id: string;
  status: ProposalStatus;
  risk: RiskLevel;
  title: string;
  category: SignalCategory;
  area: string;
  gate: GateDecision;
  stats: CohortStats;
  aiHandle: boolean;
  aiHandleApprovedBy: string | null;
  issue: { number: number; url: string } | null;
  duplicateOf: string | null;
  shippedRef: string | null;
  shippedAt: string | null;
  draftSource: 'ai' | 'template' | null;
  createdAt: string;
  updatedAt: string;
}

const NO_STATS: CohortStats = { learners: 0, occurrences: 0, avgConfidence: 0 };

export function toProposalSummary(row: ProposalListRow, stats: CohortStats | undefined): ProposalSummary {
  const source = parseJson<{ source?: unknown }>(row.draft_json, {}).source;
  return {
    id: row.id,
    status: row.status,
    risk: row.risk,
    title: row.title,
    category: row.category,
    area: row.area,
    gate: proposalGate(row),
    stats: stats ?? NO_STATS,
    aiHandle: row.ai_handle === 1,
    aiHandleApprovedBy: row.ai_handle_approved_by,
    issue: row.github_issue_number !== null && row.github_issue_url ? { number: row.github_issue_number, url: row.github_issue_url } : null,
    duplicateOf: row.duplicate_of,
    shippedRef: row.shipped_ref,
    shippedAt: row.shipped_at,
    draftSource: source === 'ai' || source === 'template' ? source : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Proposal list with current cohort statistics (two queries). */
export async function listProposalSummaries(db: D1Database, status: ProposalStatus | null, now: Date): Promise<ProposalSummary[]> {
  const [rows, stats] = await Promise.all([listProposals(db, status), cohortStatsBySignal(db, daysBefore(now, SIGNAL_WINDOW_DAYS))]);
  return rows.map((r) => toProposalSummary(r, stats.get(r.signal_id)));
}

export async function getProposalWithSignal(db: D1Database, id: string): Promise<ProposalListRow | null> {
  return db.prepare(`SELECT p.*, s.fingerprint, s.category, s.area, s.title FROM insight_proposals p
    JOIN insight_signals s ON s.id = p.signal_id WHERE p.id = ?`).bind(id).first<ProposalListRow>();
}
