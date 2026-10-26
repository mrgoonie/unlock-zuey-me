/** Report filters: session, time range, skill (competency) and mission. Native selects, applied on change. */
import type { CompetencyId } from '../../lib/content/schema';
import { COMPETENCY_LABEL } from '../../lib/ui/labels';
import type { InsightSession } from './insights-api';
import type { MissionTitles } from './InsightReportCard';

export interface FilterState { session: string; range: string; skill: string; mission: string }
export const EMPTY_FILTERS: FilterState = { session: '', range: '', skill: '', mission: '' };

/** Time-range presets (days back from now); '' = all time. */
export const RANGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Mọi lúc' },
  { value: '7', label: '7 ngày qua' },
  { value: '30', label: '30 ngày qua' },
  { value: '90', label: '90 ngày qua' },
];

/** ISO lower bound for a range preset, or null for all time. */
export function rangeFrom(range: string, now: Date = new Date()): string | null {
  const days = Number(range);
  return range && Number.isFinite(days) && days > 0 ? new Date(now.getTime() - days * 86_400_000).toISOString() : null;
}

interface Props {
  value: FilterState;
  sessions: InsightSession[];
  missionTitles: MissionTitles;
  disabled?: boolean;
  onChange: (next: FilterState) => void;
}

export default function InsightFilters({ value, sessions, missionTitles, disabled, onChange }: Props) {
  const set = (key: keyof FilterState) => (e: { target: { value: string } }) => onChange({ ...value, [key]: e.target.value });
  const active = Object.values(value).some(Boolean);
  const field = 'flex flex-col gap-1 text-sm font-medium';
  const select = 'field min-h-[44px]';
  return (
    <form className="card grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Lọc báo cáo" onSubmit={(e) => e.preventDefault()}>
      <label className={field}>
        Phiên làm việc
        <select className={select} value={value.session} onChange={set('session')} disabled={disabled}>
          <option value="">Tất cả phiên</option>
          {sessions.map((s) => <option key={s.ref} value={s.ref}>{s.label}</option>)}
        </select>
      </label>
      <label className={field}>
        Thời gian
        <select className={select} value={value.range} onChange={set('range')} disabled={disabled}>
          {RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className={field}>
        Năng lực
        <select className={select} value={value.skill} onChange={set('skill')} disabled={disabled}>
          <option value="">Tất cả năng lực</option>
          {(Object.keys(COMPETENCY_LABEL) as CompetencyId[]).map((c) => <option key={c} value={c}>{COMPETENCY_LABEL[c].name}</option>)}
        </select>
      </label>
      <label className={field}>
        Mission
        <select className={select} value={value.mission} onChange={set('mission')} disabled={disabled}>
          <option value="">Tất cả mission</option>
          {Object.entries(missionTitles).map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </select>
      </label>
      {active && (
        <button type="button" className="btn-ghost text-sm sm:col-span-2 sm:justify-self-start" disabled={disabled} onClick={() => onChange(EMPTY_FILTERS)}>
          Bỏ lọc
        </button>
      )}
    </form>
  );
}
