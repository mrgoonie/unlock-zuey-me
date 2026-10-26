/**
 * Shareable certificates. Eligible after ≥3 passed missions with at least one verify criterion scored
 * ≥ 0.8 in a passed evaluation. One certificate per level (re-issuing returns the existing code).
 * Only signed-in members can issue one: the public page shows a self-chosen display name on unlock.zuey.me,
 * so guests (anonymous, unverifiable) could impersonate anyone.
 * The snapshot freezes level, badges and competencies at issue time.
 */
import { GUEST_CERTIFICATE_PROMPT } from './certificate-messages';
import { getMission } from '../content/loader';
import { nowIso, parseJson } from '../db/ids';
import { completedMissionIds, sumXp } from '../db/progress-queries';
import { recordEventSafe } from '../observer/events';
import type { RunDeps } from './mission-runs';
import { getProgressImpl } from './progress';
import { LearningError, type CriterionResult, type LearnerContext } from './types';
import { levelForXp } from './xp-and-levels';

export const CERTIFICATE_MIN_MISSIONS = 3;
export const CERTIFICATE_MIN_VERIFY_SCORE = 0.8;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
const CODE_LENGTH = 10;

export function newCertificateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  // 32 divides 256, so `& 31` is unbiased.
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join('');
}

export function cleanDisplayName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (name.length < 1 || name.length > 60) throw new LearningError('invalid', 'Tên hiển thị cần 1–60 ký tự.');
  return name;
}

async function hasStrongVerify(db: D1Database, learnerId: string): Promise<boolean> {
  const { results } = await db.prepare(`SELECT criteria_json FROM evaluations WHERE learner_id = ? AND status = 'passed'`)
    .bind(learnerId).all<{ criteria_json: string }>();
  return results.some((r) => parseJson<CriterionResult[]>(r.criteria_json, [])
    .some((c) => c.competency === 'verify' && c.score >= CERTIFICATE_MIN_VERIFY_SCORE - 1e-9));
}

export async function issueCertificate(deps: RunDeps, learner: LearnerContext, rawName: unknown): Promise<{ code: string; url: string }> {
  const displayName = cleanDisplayName(rawName);
  const db = deps.env.DB;
  const now = deps.now?.() ?? new Date();
  const site = (deps.env.PUBLIC_SITE_URL || 'https://unlock.zuey.me').replace(/\/$/, '');
  const url = (code: string) => `${site}/certificates/${code}`;

  const completed = await completedMissionIds(db, learner.id);
  if (completed.length < CERTIFICATE_MIN_MISSIONS || !(await hasStrongVerify(db, learner.id))) {
    throw new LearningError('forbidden', `Cần hoàn thành ít nhất ${CERTIFICATE_MIN_MISSIONS} mission và có một lần kiểm chứng đạt từ ${CERTIFICATE_MIN_VERIFY_SCORE * 100}% để nhận chứng nhận.`);
  }
  if (learner.kind !== 'member') throw new LearningError('forbidden', GUEST_CERTIFICATE_PROMPT);
  const level = levelForXp(await sumXp(db, learner.id));
  const existing = await db.prepare('SELECT code, revoked_at FROM certificates WHERE learner_id = ? AND level = ?')
    .bind(learner.id, level.id).first<{ code: string; revoked_at: string | null }>();
  if (existing?.revoked_at) throw new LearningError('forbidden', 'Chứng nhận ở cấp độ này đã bị thu hồi.');
  if (existing) return { code: existing.code, url: url(existing.code) };

  const progress = await getProgressImpl(deps, learner);
  const snapshot = {
    level: level.id, levelName: level.name, xp: progress.xp,
    badges: progress.badges.map(({ id, name, emoji }) => ({ id, name, emoji })),
    competencies: progress.competencies.map(({ id, score }) => ({ id, score })),
    missions: completed.map((id) => ({ id, title: getMission(id)?.title ?? id })),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newCertificateCode();
    const r = await db.prepare(
      `INSERT INTO certificates (code, learner_id, level, display_name, snapshot_json, issued_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(code, learner.id, level.id, displayName, JSON.stringify(snapshot), nowIso(now)).run();
    if ((r.meta.changes ?? 0) > 0) {
      await recordEventSafe(db, { learnerId: learner.id, name: 'certificate.issued', props: { level: level.id } });
      return { code, url: url(code) };
    }
    // Either a code collision (retry) or a concurrent issue for the same level (return it).
    const raced = await db.prepare('SELECT code FROM certificates WHERE learner_id = ? AND level = ?').bind(learner.id, level.id).first<{ code: string }>();
    if (raced) return { code: raced.code, url: url(raced.code) };
  }
  throw new LearningError('unavailable', 'Chưa tạo được chứng nhận. Vui lòng thử lại.');
}
