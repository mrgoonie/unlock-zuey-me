/**
 * CI gate: parses every content file with the same schemas as the app and fails on any error.
 * Also fails a mission a learner could get stuck in (see `revealLockErrors`).
 * Usage: bun scripts/validate-content.ts
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Mission, RubricCriterion } from '../src/lib/content/schema';
import { parseContent, type RawFile } from '../src/lib/content/parse-content';

/**
 * Whether a criterion's score is decided only by revealable items. A quiz question or a prediction can be
 * revealed before submitting and its answer is then locked on the run (src/lib/learning/answer-reveals.ts),
 * so a learner who revealed while wrong scores 0 on such a criterion for the rest of that run:
 * `quiz_score` = right/total over the quiz's questions (all revealable), `prediction_correct` = 0 or 1.
 * Every other check, and AI criteria, can still be improved by editing answers.
 */
const isRevealLocked = (mission: Mission, c: RubricCriterion): boolean => {
  if (c.method !== 'deterministic' || !c.check) return false;
  const step = mission.steps.find((s) => s.id === c.check!.step);
  return (c.check.kind === 'quiz_score' && step?.type === 'quiz')
    || (c.check.kind === 'prediction_correct' && step?.type === 'prediction');
};

/**
 * Best score a run can still reach when every revealable item was revealed with a wrong answer: the
 * weighted score (src/lib/learning/scoring.ts weightedScore, Σ weight × score / Σ weight) with those
 * criteria at 0 and every other criterion at 1.
 */
export function bestScoreWithWrongReveals(mission: Mission): number {
  const total = mission.rubric.criteria.reduce((s, c) => s + Math.max(0, c.weight), 0);
  if (total <= 0) return 0;
  const free = mission.rubric.criteria.filter((c) => !isRevealLocked(mission, c)).reduce((s, c) => s + Math.max(0, c.weight), 0);
  return free / total;
}

/**
 * A mission fails the check when wrong-and-revealed items alone can make passing impossible: the learner
 * would be stuck on a run they can never pass (they can abandon it, but the content is still unfair).
 * Uses the same tolerance as decideStatus in src/lib/learning/scoring.ts.
 */
export function revealLockErrors(missions: Mission[]): string[] {
  const errors: string[] = [];
  for (const m of missions) {
    const best = bestScoreWithWrongReveals(m);
    if (best + 1e-9 < m.rubric.pass_score) {
      errors.push(
        `mission ${m.id}: revealable quiz/prediction criteria weigh too much: with every revealed answer wrong the best `
        + `score is ${Math.round(best * 1000) / 1000} < pass_score ${m.rubric.pass_score}, so a learner could never pass that run`,
      );
    }
  }
  return errors;
}

function main(): void {
  const root = join(import.meta.dir, '..', 'content');
  const read = (dir: string): RawFile[] =>
    existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => ({ path: join(dir, f), text: readFileSync(join(dir, f), 'utf8') }))
      : [];

  const badgesPath = join(root, 'badges.yaml');
  const result = parseContent({
    missions: read(join(root, 'missions')),
    concepts: read(join(root, 'concepts')),
    badges: existsSync(badgesPath) ? [{ path: badgesPath, text: readFileSync(badgesPath, 'utf8') }] : [],
  });

  if (result.missions.length === 0) result.errors.push(`no missions found under ${root}`);
  result.errors.push(...revealLockErrors(result.missions));
  const published = result.missions.filter((m) => m.status === 'published').length;
  console.log(`missions: ${result.missions.length} (${published} published) · concepts: ${result.concepts.length} · badges: ${result.badges.length}`);
  if (result.errors.length) {
    console.error(`\n${result.errors.length} content error(s):\n- ${result.errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log('content OK');
}

// Run only as a script (`bun scripts/validate-content.ts`); unit tests import the checks above.
if (import.meta.main) main();
