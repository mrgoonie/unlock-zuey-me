/**
 * Seeds one learner with a row in every learner-owned table (real schema via createTestD1), so observer,
 * export and delete tests run against realistic data. Not a test file itself (no .test.ts suffix).
 */
import type { LearnerContext } from '../../src/lib/learning/types';

export const T0 = '2026-10-20T13:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

export async function seedLearner(db: D1Database, id: string, opts: { consent: boolean; name?: string }): Promise<void> {
  const run = `run_${id}`;
  const sub = `sub_${id}`;
  const stmts = [
    db.prepare(`INSERT INTO learners (id, kind, display_name, email, profile_json, observer_consent, observer_consent_at, created_at, updated_at)
      VALUES (?, 'member', ?, ?, '{"timezone":"Asia/Saigon"}', ?, ?, ?, ?)`)
      .bind(id, opts.name ?? id, `${id}@example.com`, opts.consent ? 1 : 0, opts.consent ? T0 : null, T0, T0),
    db.prepare(`INSERT INTO sessions (id, token_hash, learner_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(`ses_${id}`, `hash_${id}`, id, T0, at(60 * 24 * 30), T0),
    db.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, answers_json, confidence, hint_max_level, hints_used, started_at, updated_at, completed_at)
      VALUES (?, ?, 'plan-weekend', 1, 'completed', '{}', 90, 2, 3, ?, ?, ?)`).bind(run, id, at(5), at(19), at(19)),
    db.prepare(`INSERT INTO evidence_submissions (id, run_id, learner_id, idempotency_key, answers_json, image_keys_json, created_at)
      VALUES (?, ?, ?, 'k1', ?, ?, ?)`)
      .bind(sub, run, id, JSON.stringify({ constraints: { budget: `Ngân sách của ${id}` } }), JSON.stringify([`ev/${id}/a.png`]), at(19)),
    db.prepare(`INSERT INTO evaluations (id, run_id, submission_id, learner_id, status, score, criteria_json, feedback, mode, created_at)
      VALUES (?, ?, ?, ?, 'passed', 0.84, ?, 'Tốt', 'mixed', ?)`)
      .bind(`evl_${id}`, run, sub, id, JSON.stringify([{ id: 'c1', label: 'Làm rõ ràng buộc', weight: 1, score: 1, method: 'deterministic', competency: 'describe', feedback: '' }]), at(19)),
    db.prepare(`INSERT INTO xp_ledger (id, learner_id, amount, reason, ref, created_at) VALUES (?, ?, 50, 'mission', ?, ?)`).bind(`xp_${id}`, id, run, at(19)),
    db.prepare(`INSERT INTO badge_grants (learner_id, badge_id, granted_at) VALUES (?, 'first-win', ?)`).bind(id, at(19)),
    db.prepare(`INSERT INTO competency_scores (learner_id, competency, score, evidence_count, updated_at) VALUES (?, 'verify', 0.6, 1, ?)`).bind(id, at(19)),
    db.prepare(`INSERT INTO activity_days (learner_id, day) VALUES (?, '2026-10-20')`).bind(id),
    db.prepare(`INSERT INTO lab_runs (id, learner_id, lab_id, result_json, created_at) VALUES (?, ?, 'token', '{"correct":3}', ?)`).bind(`lab_${id}`, id, at(30)),
    db.prepare(`INSERT INTO concept_views (learner_id, concept_id, first_seen_at) VALUES (?, 'token', ?)`).bind(id, at(31)),
    db.prepare(`INSERT INTO coach_messages (id, learner_id, run_id, step_id, channel, role, content, created_at) VALUES (?, ?, ?, 'constraints', 'practice', 'user', ?, ?)`)
      .bind(`cm_${id}`, id, run, `Câu hỏi của ${id}`, at(8)),
    db.prepare(`INSERT INTO ai_usage (day, learner_id, requests) VALUES ('2026-10-20', ?, 2)`).bind(id),
    db.prepare(`INSERT INTO events (id, learner_id, name, mission_id, run_id, props_json, occurred_at) VALUES (?, ?, 'mission.started', 'plan-weekend', ?, '{}', ?)`)
      .bind(`evt_${id}_1`, id, run, at(5)),
    db.prepare(`INSERT INTO events (id, learner_id, name, mission_id, run_id, props_json, occurred_at) VALUES (?, ?, 'mission.step_viewed', 'plan-weekend', ?, '{"stepId":"intro"}', ?)`)
      .bind(`evt_${id}_2`, id, run, at(6)),
    db.prepare(`INSERT INTO push_subscriptions (id, learner_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, 'p256', 'auth', ?)`)
      .bind(`psh_${id}`, id, `https://fcm.googleapis.com/fcm/send/${id}`, T0),
    db.prepare(`INSERT INTO certificates (code, learner_id, level, display_name, snapshot_json, issued_at) VALUES (?, ?, 'L1', ?, '{}', ?)`)
      .bind(`cert_${id}`, id, id, at(40)),
    db.prepare(`INSERT INTO feedback (id, learner_id, message, created_at) VALUES (?, ?, 'Hay', ?)`).bind(`fb_${id}`, id, at(41)),
    db.prepare(`INSERT INTO login_requests (state, code_verifier, learner_id, created_at, expires_at) VALUES (?, 'verifier', ?, ?, ?)`)
      .bind(`state_${id}`, id, T0, at(10)),
    // ai-tutor insights tables (migration 0008).
    db.prepare(`INSERT INTO insight_consents (learner_id, analysis, share_operator, proposals, analysis_at, updated_at) VALUES (?, 1, 0, 0, ?, ?)`)
      .bind(id, T0, T0),
    db.prepare(`INSERT INTO insight_tokens (id, learner_id, token_hash, label, adapter, created_at, expires_at) VALUES (?, ?, ?, 'MacBook', 'claude-code', ?, ?)`)
      .bind(`itk_${id}`, id, `ihash_${id}`, T0, at(60 * 24 * 90)),
    db.prepare(`INSERT INTO insight_reports (id, learner_id, session_ref, report_json, intent_summary, confidence, source_runtime, model, prompt_version, event_count,
        window_started_at, window_ended_at, created_at, expires_at)
      VALUES (?, ?, ?, '{"relevant":true}', ?, 0.7, 'claude-code', 'test-model', 1, 1, ?, ?, ?, ?)`)
      .bind(`irp_${id}`, id, `sref_${id}`, `Mục tiêu của ${id}`, at(50), at(51), at(60), at(60 * 24 * 90)),
    db.prepare(`INSERT INTO insight_events (id, learner_id, token_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json, payload_bytes,
        status, next_attempt_at, report_id, turn_ended_at, received_at, processed_at)
      VALUES (?, ?, ?, ?, ?, 'claude-code', '0.1.0', NULL, 120, 'done', ?, ?, ?, ?, ?)`)
      .bind(`iev_${id}`, id, `itk_${id}`, `idem_${id}`, `sref_${id}`, at(55), `irp_${id}`, at(50), at(50), at(60)),
    db.prepare(`INSERT INTO insight_access_audit (id, learner_id, actor_id, action, target_ref, created_at) VALUES (?, ?, 'lrn_admin', 'view_report', ?, ?)`)
      .bind(`iau_${id}`, id, `irp_${id}`, at(61)),
  ];
  await db.batch(stmts);
}

export const learnerCtx = (id: string, over: Partial<LearnerContext> = {}): LearnerContext => ({
  id, kind: 'member', email: `${id}@example.com`, displayName: id, avatarUrl: null, isAdmin: false, observerConsent: false,
  profile: {}, ...over,
});

/** Minimal APIContext stand-in for calling Astro route handlers directly. */
export function routeContext(opts: {
  learner?: LearnerContext; env: Partial<Env>; params?: Record<string, string>; url?: string; request?: Request;
}) {
  const url = new URL(opts.url ?? 'https://unlock.zuey.me/api/v1/test');
  return {
    locals: { learner: opts.learner, runtime: { env: opts.env } },
    params: opts.params ?? {},
    url,
    request: opts.request ?? new Request(url),
  } as never;
}

/** In-memory R2 stand-in supporting list (prefix + pagination) and delete. */
export function fakeBucket(keys: string[]) {
  const store = new Set(keys);
  const bucket = {
    async list({ prefix = '', cursor, limit = 1000 }: R2ListOptions = {}) {
      const all = [...store].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + limit) : undefined, delimitedPrefixes: [] };
    },
    async delete(k: string | string[]) {
      for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}
