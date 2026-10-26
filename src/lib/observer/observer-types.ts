/** Shapes returned by the consent-gated observer queries (src/lib/observer/queries.ts) to /admin and /api/v1/admin. */
import type { CriterionResult } from '../learning/types';

export interface ObservedLearner {
  id: string;
  kind: 'guest' | 'member';
  displayName: string | null;
  joinedAt: string;
  consentAt: string | null;
  lastActiveAt: string | null;
  missionsDone: number;
  xp: number;
}

export interface TimelineEvent {
  id: string;
  name: string;
  missionId: string | null;
  runId: string | null;
  props: Record<string, unknown>;
  source: string;
  occurredAt: string;
}

export interface TimelinePage {
  events: TimelineEvent[];
  /** Opaque cursor for the next (older) page, or null at the end. */
  nextCursor: string | null;
}

export interface FunnelStep {
  stepId: string;
  title: string;
  viewed: number;
  completed: number;
}

export interface MissionFunnel {
  missionId: string;
  title: string;
  started: number;
  steps: FunnelStep[];
  submitted: number;
  passed: number;
}

export interface RunHints {
  runId: string;
  missionId: string;
  startedAt: string;
  status: string;
  hintsUsed: number;
  hintMaxLevel: number;
}

export interface EvaluationSummary {
  id: string;
  runId: string;
  missionId: string;
  status: 'passed' | 'needs_revision' | 'failed';
  /** 0..1 */
  score: number;
  /** Learner's predicted score 0..100 before grading, if given. */
  confidence: number | null;
  criteria: CriterionResult[];
  createdAt: string;
}

export interface CompetencyScore {
  competency: string;
  score: number;
  evidenceCount: number;
}

export interface FirstWin {
  joinedAt: string;
  firstStartAt: string | null;
  firstPassAt: string | null;
  /** Milliseconds from the first mission start to the first passed evaluation. */
  msFromFirstStart: number | null;
}

export interface EvidenceItem {
  id: string;
  runId: string;
  missionId: string;
  answers: Record<string, unknown>;
  imageKeys: string[];
  createdAt: string;
}

export interface CoachMessage {
  id: string;
  runId: string | null;
  stepId: string | null;
  channel: 'hint' | 'practice';
  role: 'user' | 'assistant';
  content: string;
  hintLevel: number | null;
  createdAt: string;
}

export interface LearnerDetail {
  learner: ObservedLearner;
  timeline: TimelinePage;
  funnel: MissionFunnel[];
  hints: RunHints[];
  evaluations: EvaluationSummary[];
  competencies: CompetencyScore[];
  firstWin: FirstWin;
  evidence: EvidenceItem[];
  coach: CoachMessage[];
}
