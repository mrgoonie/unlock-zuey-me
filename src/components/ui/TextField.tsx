/** Labelled text input / textarea with a gentle "minimum length" counter (never blocks typing). */
import { useId } from 'react';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  min?: number;
  testId?: string;
}

export default function TextField({ label, value, onChange, multiline, rows = 4, placeholder, min = 0, testId }: Props) {
  const id = useId();
  const hintId = `${id}-hint`;
  const n = value.trim().length;
  const enough = n >= min;
  const common = {
    id,
    value,
    placeholder,
    'aria-describedby': min > 0 ? hintId : undefined,
    'data-testid': testId,
    className: 'field',
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium">{label}</label>
      {multiline ? (
        <textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type="text" onChange={(e) => onChange(e.target.value)} />
      )}
      {min > 0 && (
        <p id={hintId} className={`text-xs ${enough ? 'text-calm' : 'text-ink-muted'}`}>
          {enough ? '✓ Đủ rồi' : `Viết ít nhất ${min} ký tự (đang có ${n})`}
        </p>
      )}
    </div>
  );
}
