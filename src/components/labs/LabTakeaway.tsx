/**
 * Final screen of every lab: score, the mental model to remember, links to the concept page and missions.
 * Records the result once on mount; a failed recording shows a gentle note and never blocks the learner.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { recordLabResult, type LabResult } from '../../lib/labs/lab-recorder';
import type { LabMeta } from '../../lib/labs/registry';
import LabStepHeading from './LabStepHeading';

interface Props {
  lab: LabMeta;
  result: LabResult;
  step: number;
  takeaway: string;
  tips: string[];
  onRestart: () => void;
  children?: ReactNode;
}

type SaveState = 'saving' | 'saved' | 'offline';

export default function LabTakeaway({ lab, result, step, takeaway, tips, onRestart, children }: Props) {
  const [save, setSave] = useState<SaveState>('saving');
  const recorded = useRef(false);

  useEffect(() => {
    if (recorded.current) return;
    recorded.current = true;
    // No unmount guard: the ref makes this run once even under strict-mode remounts, and a late setState
    // on an unmounted component is a no-op in React 19.
    void recordLabResult(lab.id, result).then((o) => setSave(o.ok ? 'saved' : 'offline'));
  }, [lab.id, result]);

  return (
    <section>
      <LabStepHeading step={step} total={step} title="Xong rồi! 🎉" />
      <div className="card" aria-live="polite">
        <p className="text-sm text-ink-muted">Kết quả của bạn</p>
        <p className="text-3xl font-bold tabular-nums">
          {result.score}/{result.total}
        </p>
        {result.calibration !== undefined && (
          <p className="mt-1 text-sm">
            Độ "biết mình biết ta" (calibration): <strong className="tabular-nums">{result.calibration}/100</strong>
          </p>
        )}
        <p className="mt-1 text-xs text-ink-muted">
          {save === 'saving' && 'Đang lưu kết quả…'}
          {save === 'saved' && 'Đã lưu vào tiến độ của bạn.'}
          {save === 'offline' && 'Chưa lưu được kết quả lúc này, nhưng không sao, bạn vẫn học tiếp bình thường.'}
        </p>
      </div>
      {children}
      <div className="card mt-4 border-calm/40 bg-calm/5">
        <p className="font-semibold">💡 Điều cần nhớ</p>
        <p className="mt-1">{takeaway}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
      <div className="mt-4 grid gap-2">
        <a className="btn-primary" href="/missions">
          🎯 Thử mission
        </a>
        <a className="btn-ghost" href={`/concepts/${lab.conceptId}`}>
          📖 Đọc thêm về khái niệm này
        </a>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn-ghost" onClick={onRestart}>
            🔁 Làm lại
          </button>
          <a className="btn-ghost" href="/labs">
            🧪 Lab khác
          </a>
        </div>
      </div>
    </section>
  );
}
