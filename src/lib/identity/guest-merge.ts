/**
 * Guest → member merge statements. Run them in ONE D1 batch (atomic) together with the session rotation.
 *
 * Plain learner-owned rows move over. Tables with a uniqueness key keep the member's row on conflict:
 * - xp_ledger (learner, reason, ref): duplicates stay on the guest, so a reward is never paid twice.
 * - badge_grants / concept_views: the earliest grant / first view wins, leftovers are dropped.
 * - activity_days: union of days.
 * - competency_scores: max score, summed evidence_count, latest updated_at.
 * - certificates (learner, level): the member's certificate wins; the guest's stays on the guest row so
 *   its public code keeps resolving.
 * Finally the guest is marked merged_into the member and its sessions are revoked.
 */

const MOVE_TABLES = [
  'mission_runs', 'evidence_submissions', 'evaluations', 'lab_runs', 'coach_messages', 'events', 'push_subscriptions',
] as const;

export function guestMergeStatements(db: D1Database, guestId: string, memberId: string, nowIso: string): D1PreparedStatement[] {
  const g = guestId;
  const m = memberId;
  const s = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds);
  return [
    ...MOVE_TABLES.map((t) => s(`UPDATE ${t} SET learner_id = ? WHERE learner_id = ?`, m, g)),

    s('UPDATE OR IGNORE xp_ledger SET learner_id = ? WHERE learner_id = ?', m, g),

    // Badges: an earlier guest grant replaces the member's later grant (keeps the earliest).
    s(`UPDATE badge_grants
          SET granted_at = (SELECT gb.granted_at FROM badge_grants gb WHERE gb.learner_id = ?1 AND gb.badge_id = badge_grants.badge_id),
              ref = (SELECT gb.ref FROM badge_grants gb WHERE gb.learner_id = ?1 AND gb.badge_id = badge_grants.badge_id)
        WHERE learner_id = ?2 AND EXISTS (
          SELECT 1 FROM badge_grants gb WHERE gb.learner_id = ?1 AND gb.badge_id = badge_grants.badge_id
             AND gb.granted_at < badge_grants.granted_at)`, g, m),
    s('UPDATE OR IGNORE badge_grants SET learner_id = ? WHERE learner_id = ?', m, g),
    s('DELETE FROM badge_grants WHERE learner_id = ?', g),

    s('UPDATE OR IGNORE activity_days SET learner_id = ? WHERE learner_id = ?', m, g),
    s('DELETE FROM activity_days WHERE learner_id = ?', g),

    s(`UPDATE concept_views
          SET first_seen_at = (SELECT gc.first_seen_at FROM concept_views gc WHERE gc.learner_id = ?1 AND gc.concept_id = concept_views.concept_id)
        WHERE learner_id = ?2 AND EXISTS (
          SELECT 1 FROM concept_views gc WHERE gc.learner_id = ?1 AND gc.concept_id = concept_views.concept_id
             AND gc.first_seen_at < concept_views.first_seen_at)`, g, m),
    s('UPDATE OR IGNORE concept_views SET learner_id = ? WHERE learner_id = ?', m, g),
    s('DELETE FROM concept_views WHERE learner_id = ?', g),

    s(`UPDATE competency_scores
          SET score = MAX(score, (SELECT gs.score FROM competency_scores gs WHERE gs.learner_id = ?1 AND gs.competency = competency_scores.competency)),
              evidence_count = evidence_count + (SELECT gs.evidence_count FROM competency_scores gs WHERE gs.learner_id = ?1 AND gs.competency = competency_scores.competency),
              updated_at = MAX(updated_at, (SELECT gs.updated_at FROM competency_scores gs WHERE gs.learner_id = ?1 AND gs.competency = competency_scores.competency))
        WHERE learner_id = ?2 AND EXISTS (
          SELECT 1 FROM competency_scores gs WHERE gs.learner_id = ?1 AND gs.competency = competency_scores.competency)`, g, m),
    s('UPDATE OR IGNORE competency_scores SET learner_id = ? WHERE learner_id = ?', m, g),
    s('DELETE FROM competency_scores WHERE learner_id = ?', g),

    s('UPDATE OR IGNORE certificates SET learner_id = ? WHERE learner_id = ?', m, g),

    // Onboarding answers carry over only when the member has none yet.
    s(`UPDATE learners SET profile_json = (SELECT gl.profile_json FROM learners gl WHERE gl.id = ?1), updated_at = ?3
        WHERE id = ?2 AND profile_json = '{}'`, g, m, nowIso),
    s('UPDATE learners SET merged_into = ?, updated_at = ? WHERE id = ? AND kind = ?', m, nowIso, g, 'guest'),
    s('DELETE FROM sessions WHERE learner_id = ?', g),
  ];
}
