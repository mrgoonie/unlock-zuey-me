/**
 * Evaluates frozen answers against a mission rubric: deterministic checks by code, AI criteria by the
 * grader (one call for all AI criteria). Deterministic-only rubrics never call a model.
 */
import type { Mission } from '../content/schema';
import type { AiDeps } from '../coach/ai-gateway';
import { gradeWithAi } from '../coach/grader';
import { runCheck } from './rubric-checks';
import { decideStatus, weightedScore } from './scoring';
import type { Answers, CriterionResult, Evaluation } from './types';

export type EvaluationDraft = Omit<Evaluation, 'id' | 'runId' | 'submissionId' | 'createdAt'>;

const MAX_LIST = 6;
const pct = (n: number): number => Math.round(n * 100);
const dedupe = (xs: string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].slice(0, MAX_LIST);

export function deterministicResults(mission: Mission, answers: Answers): CriterionResult[] {
  return mission.rubric.criteria.filter((c) => c.method === 'deterministic' && c.check).map((c) => {
    const r = runCheck(mission, c.check!, answers);
    return { id: c.id, label: c.label, weight: c.weight, score: r.score, method: 'deterministic', competency: c.competency, feedback: r.feedback };
  });
}

/** Rubric order, so the UI shows criteria the way the mission author wrote them. */
const inRubricOrder = (mission: Mission, results: CriterionResult[]): CriterionResult[] =>
  mission.rubric.criteria.map((c) => results.find((r) => r.id === c.id)).filter((r): r is CriterionResult => !!r);

export function summarySentence(score: number, passScore: number, passed: boolean): string {
  return passed
    ? `Bạn đạt ${pct(score)}%, vượt mức yêu cầu ${pct(passScore)}%. Làm tốt lắm!`
    : `Bạn đạt ${pct(score)}%, cần ${pct(passScore)}% để hoàn thành. Xem góp ý bên dưới, chỉnh lại rồi nộp lần nữa nhé.`;
}

export async function evaluateAnswers(deps: AiDeps, input: {
  learnerId: string; runId: string; mission: Mission; answers: Answers; imageCount: number;
}): Promise<EvaluationDraft> {
  const { mission, answers } = input;
  const det = deterministicResults(mission, answers);
  const aiCriteria = mission.rubric.criteria.filter((c) => c.method === 'ai');
  const detNeedsWork = det.filter((d) => d.score < 1).map((d) => `${d.label}: ${d.feedback}`);

  if (aiCriteria.length === 0) {
    const score = weightedScore(det);
    const status = decideStatus(score, mission.rubric.pass_score);
    return {
      status, score, criteria: inRubricOrder(mission, det), mode: 'deterministic', graderModel: null,
      feedback: summarySentence(score, mission.rubric.pass_score, status === 'passed'),
      strengths: dedupe(det.filter((d) => d.score >= 0.8).map((d) => `${d.label}: ${d.feedback}`)),
      improvements: dedupe(detNeedsWork),
    };
  }

  const grade = await gradeWithAi(deps, { ...input, criteria: aiCriteria });
  const ai: CriterionResult[] = aiCriteria.map((c) => {
    const g = grade.criteria.find((x) => x.id === c.id)!;
    return { id: c.id, label: c.label, weight: c.weight, score: g.score, method: 'ai', competency: c.competency, feedback: g.feedback };
  });
  const criteria = inRubricOrder(mission, [...det, ...ai]);
  const score = weightedScore(criteria);
  const status = decideStatus(score, mission.rubric.pass_score);
  return {
    status, score, criteria, mode: 'mixed', graderModel: grade.model,
    feedback: `${summarySentence(score, mission.rubric.pass_score, status === 'passed')} ${grade.feedback}`,
    strengths: dedupe(grade.strengths),
    improvements: dedupe([...grade.improvements, ...detNeedsWork]),
  };
}

/** Result recorded when no grader is reachable: deterministic scores kept, AI criteria pending, nothing granted. */
export function failedEvaluationDraft(mission: Mission, answers: Answers): EvaluationDraft {
  const det = deterministicResults(mission, answers);
  const pending: CriterionResult[] = mission.rubric.criteria.filter((c) => c.method === 'ai').map((c) => ({
    id: c.id, label: c.label, weight: c.weight, score: 0, method: 'ai', competency: c.competency,
    feedback: 'Chưa chấm được tiêu chí này vì hệ thống chấm đang bận.',
  }));
  return {
    status: 'failed', score: 0, criteria: inRubricOrder(mission, [...det, ...pending]), mode: 'mixed', graderModel: null,
    feedback: 'Hệ thống chấm bài đang bận nên chưa chấm xong. Bài làm của bạn đã được lưu an toàn, hãy bấm “Chấm lại” sau ít phút nhé.',
    strengths: [], improvements: [],
  };
}
