/** Fires the `lab.started` event once per mount (guarded against React strict-mode double effects). */
import { useEffect, useRef } from 'react';
import { trackLabStarted } from '../../lib/labs/lab-recorder';

export function useLabStarted(labId: string, started: boolean): void {
  const sent = useRef(false);
  useEffect(() => {
    if (!started || sent.current) return;
    sent.current = true;
    trackLabStarted(labId);
  }, [labId, started]);
}
