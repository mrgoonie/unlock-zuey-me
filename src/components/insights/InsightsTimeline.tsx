/**
 * /insights island: processing state, filters, the newest-first report timeline with "Xem thêm", per-report
 * rating and delete, and "Xoá tất cả báo cáo" behind a typed XOA confirmation. Status changes are announced
 * through one polite live region; focus moves to the list heading after a delete so keyboard users keep
 * their place.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import InsightFilters, { EMPTY_FILTERS, rangeFrom, type FilterState } from './InsightFilters';
import InsightReportCard, { type MissionTitles } from './InsightReportCard';
import {
  deleteAllReports, deleteReport, fetchReports, formatDateTime, rateReport,
  type InsightQueueState, type InsightReportView, type InsightSession,
} from './insights-api';

const CONFIRM_WORD = 'XOA';

export default function InsightsTimeline({ missionTitles }: { missionTitles: MissionTitles }) {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [reports, setReports] = useState<InsightReportView[]>([]);
  const [sessions, setSessions] = useState<InsightSession[]>([]);
  const [queue, setQueue] = useState<InsightQueueState | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [typed, setTyped] = useState('');
  const [deletingAll, setDeletingAll] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async (f: FilterState, after: string | null) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchReports({ cursor: after, from: rangeFrom(f.range), skill: f.skill, mission: f.mission, session: f.session });
      if (seq !== requestSeq.current) return; // a newer filter change won
      setReports((prev) => (after ? [...prev, ...res.reports] : res.reports));
      setSessions(res.sessions);
      setQueue(res.queue);
      setCursor(res.nextCursor);
    } catch (err) {
      if (seq === requestSeq.current) setError(err instanceof Error ? err.message : 'Chưa tải được báo cáo.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(filters, null); }, [filters, load]);

  const onRate = async (id: string, useful: boolean) => {
    await rateReport(id, useful);
    setReports((prev) => prev.map((r) => (r.id === id ? { ...r, useful } : r)));
    setStatus(useful ? 'Cảm ơn bạn! Đã ghi nhận báo cáo này hữu ích.' : 'Đã ghi nhận. ai-tutor sẽ dùng phản hồi này để làm tốt hơn.');
  };

  const onDelete = async (id: string) => {
    await deleteReport(id);
    setReports((prev) => prev.filter((r) => r.id !== id));
    setStatus('Đã xoá báo cáo.');
    listHeading.current?.focus();
  };

  const onDeleteAll = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (typed.trim() !== CONFIRM_WORD) return;
    setDeletingAll(true);
    setError(null);
    try {
      const { deleted } = await deleteAllReports();
      setTyped('');
      setStatus(`Đã xoá ${deleted} báo cáo và các lượt đang chờ phân tích.`);
      await load(filters, null);
      listHeading.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chưa xoá được, thử lại sau nhé.');
    } finally {
      setDeletingAll(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="card flex flex-col gap-1 text-sm" aria-labelledby="ins-queue-h">
        <h2 id="ins-queue-h" className="font-semibold">Trạng thái xử lý</h2>
        {queue ? (
          <p data-testid="insights-queue">
            {queue.pending > 0 ? `${queue.pending} lượt đang chờ ai-tutor phân tích.` : 'Không có lượt nào đang chờ.'}{' '}
            Lượt gần nhất nhận lúc {formatDateTime(queue.lastReceivedAt)}.
          </p>
        ) : (
          <p className="text-ink-muted">{loading ? 'Đang tải…' : '—'}</p>
        )}
        <p className="text-ink-muted">ai-tutor chạy định kỳ khoảng 15 phút một lần, nên báo cáo mới có thể xuất hiện sau vài phút.</p>
      </section>

      <InsightFilters value={filters} sessions={sessions} missionTitles={missionTitles} disabled={deletingAll} onChange={setFilters} />

      <section className="flex flex-col gap-3" aria-labelledby="ins-list-h" aria-busy={loading}>
        <h2 id="ins-list-h" ref={listHeading} tabIndex={-1} className="font-semibold">Báo cáo của bạn</h2>
        <p role="status" aria-live="polite" className="sr-only">{status}</p>
        {error && (
          <div role="alert" className="card flex flex-col items-start gap-2 text-sm">
            <p className="text-danger">{error}</p>
            <button type="button" className="btn-ghost" onClick={() => load(filters, null)}>Thử lại</button>
          </div>
        )}
        {!error && !loading && reports.length === 0 && (
          <p className="card text-sm text-ink-muted">
            {Object.values(filters).some(Boolean)
              ? 'Không có báo cáo nào khớp bộ lọc.'
              : 'Chưa có báo cáo nào. Sau khi bạn kết nối Claude Code và làm việc một lúc, ai-tutor sẽ tóm tắt phiên của bạn ở đây.'}
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {reports.map((r) => (
            <li key={r.id}><InsightReportCard report={r} missionTitles={missionTitles} onRate={onRate} onDelete={onDelete} /></li>
          ))}
        </ul>
        {loading && <p className="text-sm text-ink-muted">Đang tải báo cáo…</p>}
        {cursor && !loading && (
          <button type="button" className="btn-ghost self-center" onClick={() => load(filters, cursor)}>Xem thêm</button>
        )}
      </section>

      <form onSubmit={onDeleteAll} className="flex flex-col gap-2 rounded-xl border border-danger/40 p-3">
        <p className="font-semibold text-danger">Xoá tất cả báo cáo</p>
        <p className="text-sm text-ink-muted">
          Xoá vĩnh viễn mọi báo cáo ai-tutor của bạn và các lượt đang chờ phân tích. Không thể hoàn tác. Quyền phân tích và thiết bị đã kết nối vẫn giữ nguyên (đổi trong Cài đặt).
        </p>
        <label htmlFor="ins-delete-all" className="text-sm font-medium">
          Gõ <strong>{CONFIRM_WORD}</strong> (không dấu) để xác nhận
        </label>
        <input id="ins-delete-all" className="field min-h-[44px]" value={typed} autoComplete="off" autoCapitalize="characters"
          spellCheck={false} onChange={(e) => setTyped(e.target.value)} disabled={deletingAll} />
        <button type="submit" className="btn min-h-[44px] bg-danger text-white disabled:opacity-50"
          disabled={deletingAll || typed.trim() !== CONFIRM_WORD}>
          {deletingAll ? 'Đang xoá…' : 'Xoá tất cả báo cáo'}
        </button>
      </form>
    </div>
  );
}
