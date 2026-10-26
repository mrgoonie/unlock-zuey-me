/**
 * Step heading with a progress line. When a new step mounts it receives focus so keyboard and screen-reader
 * users land on the new content instead of the button that just disappeared.
 */
import { useEffect, useRef } from 'react';

interface Props {
  step: number;
  total: number;
  title: string;
  /** Skip focusing (first step, so page load does not jump). */
  noFocus?: boolean;
}

export default function LabStepHeading({ step, total, title, noFocus = false }: Props) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!noFocus) ref.current?.focus();
  }, [noFocus, step, title]);
  const pct = Math.round((Math.min(step, total) / total) * 100);
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-ink-muted">
        Bước {Math.min(step, total)}/{total}
      </p>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-label="Tiến độ lab"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="h-full rounded-full bg-calm transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <h2 ref={ref} tabIndex={-1} className="mt-3 text-xl font-bold">
        {title}
      </h2>
    </div>
  );
}
