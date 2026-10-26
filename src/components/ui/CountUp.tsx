/**
 * Animated number (ease-out count-up). Screen readers get only the final value; reduced motion shows it
 * immediately. `onTick` lets the caller play a soft sound while counting.
 */
import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../../lib/ui/reduced-motion';

export default function CountUp({ to, durationMs = 1200, prefix = '', suffix = '', onDone }: {
  to: number; durationMs?: number; prefix?: string; suffix?: string; onDone?: () => void;
}) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion() || to <= 0) {
      setValue(to);
      onDone?.();
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / durationMs);
      setValue(Math.round(to * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
      else onDone?.();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, durationMs]);
  return (
    <>
      <span aria-hidden="true">{prefix}{value}{suffix}</span>
      <span className="sr-only">{prefix}{to}{suffix}</span>
    </>
  );
}
