/**
 * Shared learning-domain types. The web API (src/pages/api/v1) and the /mcp tools (src/lib/mcp) both talk
 * to src/lib/learning/service.ts with these shapes, so web and MCP always see the same state.
 */
import type { CompetencyId } from '../content/schema';

export type LearnerKind = 'guest' | 'member';
export type Source = 'web' | 'mcp';

/** Who is making the request. Built by src/middleware.ts (cookie session) or the MCP auth props. */
export interface LearnerContext {
  id: string;
  kind: LearnerKind;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  observerConsent: boolean;
  profile: LearnerProfile;
}

/** Onboarding answers and preferences (learners.profile_json). Every field is optional: onboarding is skippable. */
export interface LearnerProfile {
  goal?: 'everyday-life' | 'work' | 'curious';
  familiarity?: 'never' | 'basic' | 'regular';
  obstacle?: 'dont-know-what-to-ask' | 'dont-trust-answers' | 'no-time' | 'too-technical';
  sound?: boolean;
  reducedMotion?: boolean;
  timezone?: string;
}

export type RunStatus =
  | 'started' | 'paused' | 'awaiting_evidence' | 'evaluating'
  | 'needs_revision' | 'evaluation_failed' | 'completed' | 'abandoned';

/** {stepId: {fieldId: value}}. Values are strings, string lists (list fields) or numbers (confidence). */
export type Answers = Record<string, Record<string, string | string[] | number>>;

export interface MissionRun {
  id: string;
  learnerId: string;
  missionId: string;
  missionVersion: number;
  status: RunStatus;
  currentStep: string | null;
  answers: Answers;
  confidence: number | null;
  hintMaxLevel: number;
  hintsUsed: number;
  source: Source;
  rev: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CriterionResult {
  id: string;
  label: string;
  weight: number;
  /** 0..1 */
  score: number;
  method: 'deterministic' | 'ai';
  competency: CompetencyId;
  feedback: string;
}

export interface Evaluation {
  id: string;
  runId: string;
  submissionId: string;
  status: 'passed' | 'needs_revision' | 'failed';
  /** Weighted 0..1 */
  score: number;
  criteria: CriterionResult[];
  feedback: string;
  strengths: string[];
  improvements: string[];
  mode: 'deterministic' | 'mixed';
  graderModel: string | null;
  createdAt: string;
}

/** What a submission earned. XP is only granted when the evaluation passed. */
export interface Rewards {
  xpGained: number;
  xpTotal: number;
  level: LevelInfo;
  newBadges: Array<{ id: string; name: string; emoji: string }>;
  streak: StreakInfo;
}

export interface SubmitResult {
  run: MissionRun;
  evaluation: Evaluation;
  rewards: Rewards;
  /** True when the same idempotency key was already processed (result replayed, nothing granted twice). */
  replayed: boolean;
}

export interface LevelInfo {
  id: 'L0' | 'L1' | 'L2' | 'L3';
  name: string;
  xpIntoLevel: number;
  xpForNext: number | null;
}

/** Soft streak: counts active days, tolerating up to 1 rest day per 7. */
export interface StreakInfo {
  current: number;
  restDaysLeft: number;
  activeToday: boolean;
}

export interface ProgressSummary {
  learner: Pick<LearnerContext, 'id' | 'kind' | 'displayName'>;
  xp: number;
  level: LevelInfo;
  streak: StreakInfo;
  competencies: Array<{ id: CompetencyId; score: number; evidenceCount: number }>;
  badges: Array<{ id: string; name: string; emoji: string; grantedAt: string }>;
  completedMissions: string[];
  activeRuns: Array<Pick<MissionRun, 'id' | 'missionId' | 'status' | 'currentStep' | 'updatedAt'>>;
  labsDone: string[];
  conceptsSeen: number;
}

export interface MissionListItem {
  id: string;
  title: string;
  tagline: string;
  emoji: string;
  estimatedMinutes: number;
  riskTier: 'low' | 'medium' | 'high';
  competencies: CompetencyId[];
  status: 'new' | 'in_progress' | 'completed';
  recommended: boolean;
}

export interface HintResult {
  level: 1 | 2 | 3 | 4;
  text: string;
  /** 'ai' when the coach model answered, 'static' when it fell back to the mission's authored hint. */
  origin: 'ai' | 'static';
}

export class LearningError extends Error {
  constructor(
    public code: 'not_found' | 'forbidden' | 'conflict' | 'invalid' | 'rate_limited' | 'budget_exceeded' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}
