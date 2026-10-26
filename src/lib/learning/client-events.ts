/**
 * Client-reported events (POST /api/v1/events). Only an allow-list of UI events is accepted; state-changing
 * events (evidence, XP, badges...) are emitted by the server only. Props are small scalars, never free text
 * beyond 200 characters.
 */
import { getMission } from '../content/loader';
import { recordEventSafe, type EventName } from '../observer/events';
import { loadRun } from './mission-runs';
import type { RunDeps } from './mission-runs';
import { LearningError, type LearnerContext } from './types';

// mission.step_completed is emitted by the server when a run's currentStep advances (saveAnswers), so the
// observer funnel never double counts; clients report step views only.
export const CLIENT_EVENTS = [
  'onboarding.completed', 'onboarding.skipped', 'mission.step_viewed', 'reflection.submitted', 'lab.started', 'push.opened',
] as const satisfies readonly EventName[];

/** Props a client event must carry (the observer funnel groups by them). */
const REQUIRED_PROPS: Partial<Record<(typeof CLIENT_EVENTS)[number], string>> = {
  'mission.step_viewed': 'stepId',
  'lab.started': 'labId',
};

type Scalar = string | number | boolean | null;

export function cleanEventProps(raw: unknown): Record<string, Scalar> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new LearningError('invalid', 'props phải là object.');
  const entries = Object.entries(raw);
  if (entries.length > 10) throw new LearningError('invalid', 'Tối đa 10 props.');
  const out: Record<string, Scalar> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) throw new LearningError('invalid', `Tên prop không hợp lệ: ${k.slice(0, 40)}`);
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
    else throw new LearningError('invalid', `Prop ${k} phải là chữ, số hoặc true/false.`);
  }
  return out;
}

export async function recordClientEvent(
  deps: RunDeps, learner: LearnerContext, input: { name: string; missionId?: string; runId?: string; props?: unknown },
): Promise<void> {
  const name = CLIENT_EVENTS.find((e) => e === input.name);
  if (!name) throw new LearningError('invalid', 'Sự kiện không được hỗ trợ.');
  const props = cleanEventProps(input.props);
  const required = REQUIRED_PROPS[name];
  if (required && (typeof props[required] !== 'string' || props[required] === '')) {
    throw new LearningError('invalid', `Sự kiện ${name} cần props.${required}.`);
  }
  let missionId = input.missionId;
  let missionVersion: number | undefined;
  if (input.runId) {
    const run = await loadRun(deps, learner, input.runId);
    if (missionId && missionId !== run.missionId) throw new LearningError('invalid', 'missionId không khớp với lượt làm bài.');
    missionId = run.missionId;
    missionVersion = run.missionVersion;
  }
  if (missionId) {
    const mission = getMission(missionId);
    if (!mission) throw new LearningError('not_found', 'Không tìm thấy mission này.');
    missionVersion ??= mission.version;
  }
  await recordEventSafe(deps.env.DB, { learnerId: learner.id, name, missionId, missionVersion, runId: input.runId, props });
}
