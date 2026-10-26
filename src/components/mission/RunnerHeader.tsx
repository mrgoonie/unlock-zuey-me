/** Runner top bar: exit link, progress dots (current/done/todo) and the autosave status. */
import type { Mission } from '../../lib/content/schema';
import type { SaveState } from './use-run-autosave';

const SAVE_COPY: Record<SaveState, string> = {
  idle: '',
  saving: 'Đang lưu…',
  saved: '✓ Đã lưu',
  offline: 'Đã lưu trên máy này, sẽ đồng bộ khi có mạng',
};

interface Props {
  mission: Mission;
  stepIndex: number;
  completed: boolean[];
  saveState: SaveState;
  /** Dots are clickable while answering (free navigation between steps). */
  onJump?: (i: number) => void;
}

export default function RunnerHeader({ mission, stepIndex, completed, saveState, onJump }: Props) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <a href={`/missions/${mission.id}`} className="btn-ghost min-h-[44px] shrink-0 whitespace-nowrap px-3 text-sm" aria-label="Thoát (bài làm đã được lưu)">← Thoát</a>
        <p className="truncate text-sm font-semibold">{mission.emoji} {mission.title}</p>
        <p className={`min-w-[4rem] text-right text-xs ${saveState === 'offline' ? 'text-warn' : 'text-ink-muted'}`} role="status" data-testid="save-state">
          {SAVE_COPY[saveState]}
        </p>
      </div>
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
