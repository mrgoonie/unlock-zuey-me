/**
 * Four-level hint ladder per step (POST /api/v1/runs/:id/hints). Levels unlock in order. If the coach is
 * unavailable the mission's authored hint for that level is shown instead, so a hint never fails.
 */
import { useState } from 'react';
import type { MissionStep } from '../../lib/content/schema';
import type { HintResult } from '../../lib/learning/types';
import { api } from '../../lib/ui/api-client';
import type { RunDraft } from '../../lib/ui/run-draft';

const LEVEL_NAME = ['Gợi ý nhỏ', 'Bước tiếp theo', 'Ví dụ tương tự', 'Giải thích trực tiếp'];

interface Props {
  step: MissionStep;
  runId: string;
  hints: HintResult[];
  patchDraft: (fn: (d: RunDraft) => RunDraft) => void;
}

export default function HintLadder({ step, runId, hints, patchDraft }: Props) {
  const [busy, setBusy] = useState(false);
  const next = hints.length + 1;

  async function ask() {
    if (next > 4 || busy) return;
    const level = next as 1 | 2 | 3 | 4;
    setBusy(true);
    let hint: HintResult;
    try {
      hint = await api.hint(runId, step.id, level);
    } catch {
      hint = { level, text: step.hints[level - 1], origin: 'static' };
    } finally {
      setBusy(false);
    }
    patchDraft((d) => ({ ...d, hints: { ...d.hints, [step.id]: [...(d.hints[step.id] ?? []), hint] } }));
  }

  return (
    <section aria-label="Gợi ý" className="flex flex-col gap-2" data-testid="hint-ladder">
      <div aria-live="polite" className="flex flex-col gap-2">
        {hints.map((h) => (
          <div key={h.level} className="rounded-xl border border-calm/40 bg-calm/5 p-3 text-sm" data-testid={`hint-level-${h.level}`}>
            <p className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-calm">
              <span>💡 Nấc {h.level}/4 · {LEVEL_NAME[h.level - 1]}</span>
              <span className="font-normal text-ink-muted">{h.origin === 'ai' ? 'AI coach' : 'Gợi ý có sẵn'}</span>
            </p>
            <p className="whitespace-pre-line">{h.text}</p>
          </div>
        ))}
      </div>
      {next <= 4 ? (
        <button type="button" className="btn-ghost self-start text-sm" onClick={ask} disabled={busy} data-testid="hint-button">
          💡 {busy ? 'Đang nghĩ gợi ý…' : `${hints.length ? 'Gợi ý thêm' : 'Gợi ý nhỏ'} (nấc ${next}/4)`}
        </button>
      ) : (
        <p className="text-xs text-ink-muted">Bạn đã xem hết 4 nấc gợi ý cho bước này.</p>
      )}
    </section>
  );
}
