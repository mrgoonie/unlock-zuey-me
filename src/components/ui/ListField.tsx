/**
 * List answer field: one input per item with "Thêm dòng" (easier on phones than newline-separated text).
 * Pasting multi-line text into an item splits it into several items.
 */
import { useId, useRef } from 'react';
import { listItems } from '../../lib/ui/mission-steps';

interface Props {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  min?: number;
  testId?: string;
}

export default function ListField({ label, value, onChange, placeholder, min = 1, testId }: Props) {
  const id = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const examples = (placeholder ?? '').split('\n').filter(Boolean);
  // Show `min` empty rows up front so the learner sees how many ideas are expected.
  const rows = value.length ? value : Array.from({ length: Math.max(1, min) }, () => '');
  const filled = listItems(value).length;

  const focusRow = (i: number) => requestAnimationFrame(() => listRef.current?.querySelectorAll('input')[i]?.focus());
  const setRow = (i: number, text: string) => {
    const next = [...rows];
    const parts = text.split('\n');
    next.splice(i, 1, ...parts);
    onChange(next);
    if (parts.length > 1) focusRow(i + parts.length - 1);
  };
  const addRow = () => { onChange([...rows, '']); focusRow(rows.length); };
  const removeRow = (i: number) => { onChange(rows.filter((_, j) => j !== i)); focusRow(Math.max(0, i - 1)); };

  return (
    <fieldset className="flex flex-col gap-2" data-testid={testId}>
      <legend className="mb-1.5 font-medium">{label}</legend>
      <ol ref={listRef} className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <li key={i} className="flex items-center gap-2">
            <span aria-hidden="true" className="w-5 shrink-0 text-right text-sm text-ink-muted">{i + 1}.</span>
            <input
              id={i === 0 ? id : undefined}
              type="text"
              className="field"
              value={row}
              aria-label={`${label}, dòng ${i + 1}`}
              placeholder={examples[i] ?? ''}
              onChange={(e) => setRow(i, e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (text.includes('\n')) { e.preventDefault(); setRow(i, text); }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(); } }}
            />
            {rows.length > 1 && (
              <button type="button" className="btn-ghost min-w-[44px] px-2" aria-label={`Xoá dòng ${i + 1}`} onClick={() => removeRow(i)}>✕</button>
            )}
          </li>
        ))}
      </ol>
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="btn-ghost text-sm" onClick={addRow}>＋ Thêm dòng</button>
        <p className={`text-xs ${filled >= min ? 'text-calm' : 'text-ink-muted'}`} aria-live="polite">
          {filled >= min ? `✓ ${filled} ý` : `Cần ít nhất ${min} ý (đang có ${filled})`}
        </p>
      </div>
    </fieldset>
  );
}
