/** Weekly recap (GET /api/v1/recap?period=week), loaded after the page renders. */
import { useEffect, useState } from 'react';
import { api, friendlyMessage, type Recap } from '../../lib/ui/api-client';
import { COMPETENCY_LABEL } from '../../lib/ui/labels';
import type { CompetencyId } from '../../lib/content/schema';

/** The contract leaves competencyDeltas loosely typed: accept a map or a list. */
function deltas(r: Recap): Array<{ id: string; delta: number }> {
  const raw = r.competencyDeltas;
  const list = Array.isArray(raw) ? raw : Object.entries(raw ?? {}).map(([id, delta]) => ({ id, delta: Number(delta) }));
  return list.filter((d) => Number.isFinite(d.delta) && d.delta !== 0);
}

export default function WeeklyRecap() {
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.recap().then(setRecap).catch((e) => setError(friendlyMessage(e)));
  }, []);

  if (error) return <p className="text-sm text-ink-muted">Chưa tải được tổng kết tuần. {error}</p>;
  if (!recap) return <p className="text-sm text-ink-muted" role="status">Đang tổng kết tuần của bạn…</p>;

  const ds = deltas(recap);
  return (
    <div className="flex flex-col gap-3" data-testid="weekly-recap">
      <div className="grid grid-cols-2 gap-3">
        <p className="rounded-xl bg-bg p-3 text-center"><span className="block text-2xl font-bold">{recap.missionsCompleted}</span><span className="text-xs text-ink-muted">mission hoàn thành</span></p>
        <p className="rounded-xl bg-bg p-3 text-center"><span className="block text-2xl font-bold text-accent">+{recap.xpGained}</span><span className="text-xs text-ink-muted">XP tuần này</span></p>
      </div>
      {ds.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {ds.map((d) => {
            const label = COMPETENCY_LABEL[d.id as CompetencyId];
            return <li key={d.id} className="chip">{label?.emoji} {label?.name ?? d.id} {d.delta > 0 ? '↑' : '↓'} {Math.round(Math.abs(d.delta) * 100)}%</li>;
          })}
        </ul>
      )}
      {recap.highlights.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{recap.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>}
      {recap.reflections.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Bạn đã đúc kết:</p>
          <ul className="mt-1 flex flex-col gap-1">{recap.reflections.map((r, i) => <li key={i} className="border-l-2 border-calm pl-3 italic">“{r}”</li>)}</ul>
        </div>
      )}
      {recap.missionsCompleted === 0 && <p className="text-sm text-ink-muted">Tuần này chưa có mission nào. Một mission 10 phút là đủ để bắt đầu!</p>}
    </div>
  );
}
