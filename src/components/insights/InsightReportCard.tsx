/**
 * One ai-tutor report: intent with confidence, what was tried, verification gaps, progress points, the next
 * suggestion (linked to its mission), a provenance line, "Hữu ích" / "Không hữu ích" and an inline-confirmed
 * delete. Everything shown is an observation of visible session events, never the model's hidden reasoning.
 */
import { useState, type ReactNode } from 'react';
import { COMPETENCY_LABEL } from '../../lib/ui/labels';
import type { CompetencyId } from '../../lib/content/schema';
import { confidenceLabel, formatDateTime, provenanceLine, RISK_KIND_LABELS, type InsightReportView } from './insights-api';

export type MissionTitles = Record<string, string>;

interface Props {
  report: InsightReportView;
  missionTitles: MissionTitles;
  /** Absent in read-only contexts. */
  onRate?: (id: string, useful: boolean) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

const skillName = (id: string) => {
  const l = COMPETENCY_LABEL[id as CompetencyId];
  return l ? `${l.emoji} ${l.name}` : id;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-sm font-semibold">{title}</h4>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

export default function InsightReportCard({ report: r, missionTitles, onRate, onDelete }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = `irp-h-${r.id}`;
  const missionTitle = r.missionId ? missionTitles[r.missionId] ?? r.missionId : null;
  const nextMission = r.next?.missionId;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Có lỗi xảy ra, thử lại sau nhé.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card flex flex-col gap-3" aria-labelledby={headingId} data-testid="insight-report">
      <header className="flex flex-col gap-1">
        <p className="text-xs text-ink-muted">
          <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
          {missionTitle && <> · Mission: {missionTitle}</>}
        </p>
        <h3 id={headingId} className="font-semibold">🎯 {r.intent.text}</h3>
        <p className="text-xs text-ink-muted">Ý định được suy ra từ lời nhắn · {confidenceLabel(r.intent.confidence)}</p>
      </header>

      {r.workflow.length > 0 && (
        <Section title="Bạn đã thử">
          <ol className="list-decimal space-y-1 pl-5">{r.workflow.map((w, i) => <li key={i}>{w.step}</li>)}</ol>
        </Section>
      )}
      {r.gaps.length > 0 && (
        <Section title="Chỗ chưa kiểm chứng">
          <ul className="list-disc space-y-1 pl-5">{r.gaps.map((g, i) => <li key={i}>{g.note}</li>)}</ul>
        </Section>
      )}
      {r.risks.length > 0 && (
        <Section title="Điều cần lưu ý">
          <ul className="list-disc space-y-1 pl-5">
            {r.risks.map((k, i) => <li key={i}><span className="font-medium">{RISK_KIND_LABELS[k.kind] ?? k.kind}:</span> {k.note}</li>)}
          </ul>
        </Section>
      )}
      {r.learning.length > 0 && (
        <Section title="Điểm tiến bộ">
          <ul className="flex flex-col gap-1">
            {r.learning.map((l, i) => <li key={i}><span className="chip mr-1">{skillName(l.skill)}</span>{l.note}</li>)}
          </ul>
        </Section>
      )}
      {r.next && (
        <Section title="Gợi ý tiếp theo">
          <p>{r.next.text}</p>
          {nextMission && (
            <a href={`/missions/${encodeURIComponent(nextMission)}`} className="mt-1 inline-flex min-h-[44px] items-center font-semibold text-accent">
              Mở mission {missionTitles[nextMission] ?? nextMission} →
            </a>
          )}
        </Section>
      )}

      <p className="text-xs text-ink-muted">{provenanceLine(r.provenance)} · {confidenceLabel(r.confidence)}</p>

      {(onRate || onDelete) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {onRate && (
            <div role="group" aria-label="Báo cáo này có hữu ích không?" className="flex gap-2">
              <button type="button" className="btn-ghost text-sm aria-pressed:border-calm aria-pressed:bg-calm/15 aria-pressed:text-calm" aria-pressed={r.useful === true} disabled={busy}
                onClick={() => run(() => onRate(r.id, true))}>
                👍 Hữu ích
              </button>
              <button type="button" className="btn-ghost text-sm aria-pressed:border-calm aria-pressed:bg-calm/15 aria-pressed:text-calm" aria-pressed={r.useful === false} disabled={busy}
                onClick={() => run(() => onRate(r.id, false))}>
                👎 Không hữu ích
              </button>
            </div>
          )}
          {onDelete && !confirming && (
            <button type="button" className="btn-ghost ml-auto text-sm text-danger" disabled={busy} onClick={() => setConfirming(true)}>
              Xoá
            </button>
          )}
          {onDelete && confirming && (
            <div role="group" aria-label="Xác nhận xoá báo cáo" className="ml-auto flex items-center gap-2">
              <span className="text-sm">Xoá báo cáo này?</span>
              <button type="button" className="btn min-h-[44px] bg-danger text-sm text-white disabled:opacity-50" disabled={busy}
                autoFocus onClick={() => run(() => onDelete(r.id))}>
                Xoá
              </button>
              <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={() => setConfirming(false)}>Huỷ</button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </article>
  );
}
