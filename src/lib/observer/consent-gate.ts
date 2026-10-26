/**
 * The observer consent gate as a SQL fragment. Every observer query joins the learners row through this
 * fragment, so consent is evaluated inside the same statement that reads the data: a learner who revokes
 * consent disappears from the very next query, with no cache or separate check that could go stale.
 *
 * Usage: `FROM events e ${consentJoin('e')} WHERE e.learner_id = ?`
 */
export const consentJoin = (alias: string): string =>
  `JOIN learners l ON l.id = ${alias}.learner_id AND l.observer_consent = 1 AND l.deleted_at IS NULL`;

/** WHERE condition for queries that read the learners table itself (alias `l`). */
export const CONSENTED_LEARNER = 'l.observer_consent = 1 AND l.deleted_at IS NULL';
