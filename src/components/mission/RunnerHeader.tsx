/**
 * Runner top bar: exit link, progress dots (current/done/todo), the autosave status and its notices, and the
 * way out when a step cannot be saved because its revealed answers disagree with the server.
 */
import { useState } from 'react';
import type { LearnerMission } from '../../lib/learning/learner-mission-view';
import type { SaveState } from './use-run-autosave';

const SAVE_COPY: Record<SaveState, string> = {
  idle: '',
  saving: 'Đang lưu…',
  saved: '✓ Đã lưu',
  offline: 'Đã lưu trên máy này, sẽ đồng bộ khi có mạng',
};

interface Props {
  mission: LearnerMission;
  stepIndex: number;
  completed: boolean[];
  saveState: SaveState;
  /** Calm notice from autosave (e.g. a revealed answer was kept as it was). */
  notice?: string | null;
  /** Dots are clickable while answering (free navigation between steps). */
  onJump?: (i: number) => void;
  /** Step whose save the server keeps refusing as locked (lock recovery exhausted), if any. */
  lockedStepId?: string | null;
  /** Reloads the server copy of that step (its unsaved edits are dropped); other steps keep their edits. */
  onReloadLocked?: () => Promise<void>;
}

export default function RunnerHeader({ mission, stepIndex, completed, saveState, notice, onJump, lockedStepId, onReloadLocked }: Props) {
  const [reloading, setReloading] = useState(false);
  const lockedIndex = lockedStepId ? mission.steps.findIndex((st) => st.id === lockedStepId) : -1;
  const reload = async () => {
    if (!onReloadLocked || reloading) return;
    setReloading(true);
    try {
      await onReloadLocked();
    } finally {
      setReloading(false);
    }
  };
  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <a href={`/missions/${mission.id}`} className="btn-ghost min-h-[44px] shrink-0 whitespace-nowrap px-3 text-sm" aria-label="Thoát (bài làm đã được lưu)">← Thoát</a>
        <p className="truncate text-sm font-semibold">{mission.emoji} {mission.title}</p>
        <p className={`min-w-[4rem] text-right text-xs ${saveState === 'offline' ? 'text-warn' : 'text-ink-muted'}`} role="status" data-testid="save-state">
          {SAVE_COPY[saveState]}
        </p>
      </div>
      <p role="status" className={notice ? 'text-center text-xs text-ink-muted' : 'sr-only'} data-testid="save-notice">{notice ?? ''}</p>
      {lockedStepId && onReloadLocked && (
        <div role="alert" className="card flex flex-col gap-2 border-warn/50 bg-warn/5 text-sm" data-testid="locked-step-notice">
          <p>
            {lockedIndex >= 0 ? `Bước ${lockedIndex + 1} (${mission.steps[lockedIndex].title})` : 'Một bước'} chưa lưu được: câu trả lời
            đã xem đáp án ở bước này không khớp với bản trên máy chủ. Bạn có thể tải lại bản đã lưu của bước này; chỉ những thay đổi
            chưa lưu ở bước này bị bỏ, các bước khác vẫn giữ nguyên.
          </p>
          <button type="button" className="btn-ghost min-h-[44px] self-start px-3 text-sm" onClick={() => void reload()}
            disabled={reloading} aria-busy={reloading} data-testid="locked-step-reload">
            {reloading ? 'Đang tải lại…' : 'Tải lại bước này từ máy chủ'}
          </button>
        </div>
      )}
      <nav aria-label="Các bước">
        <ol className="flex items-center justify-center gap-1.5" data-testid="progress-dots">
          {mission.steps.map((s, i) => {
            const current = i === stepIndex;
            const cls = current ? 'w-6 bg-accent' : completed[i] ? 'w-2.5 bg-calm' : 'w-2.5 bg-line';
            const label = `Bước ${i + 1}: ${s.title}${completed[i] ? ' (đã xong)' : ''}`;
            return (
              <li key={s.id}>
                {onJump ? (
                  <button type="button" onClick={() => onJump(i)} aria-label={label} aria-current={current ? 'step' : undefined}
                    className="flex h-11 min-w-[32px] items-center justify-center">
                    <span className={`block h-2.5 rounded-full transition-all ${cls}`} />
                  </button>
                ) : (
                  <span className={`block h-2.5 rounded-full ${cls}`} aria-label={label} />
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </header>
  );
}
