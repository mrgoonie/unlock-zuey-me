/** Accessible 0–100% slider with a live value and friendly anchors. Native range input (keyboard ready). */
import { useId } from 'react';

interface Props {
  label: string;
  value: number | null;
  onChange: (v: number) => void;
  testId?: string;
}

const describe = (v: number) => (v < 34 ? 'chưa chắc lắm' : v < 67 ? 'tương đối chắc' : 'rất chắc');

export default function ConfidenceSlider({ label, value, onChange, testId }: Props) {
  const id = useId();
  const v = value ?? 50;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="font-medium">{label}</label>
        <output htmlFor={id} className="text-lg font-bold text-accent" aria-live="polite">{v}%</output>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={v}
        aria-valuetext={`${v}%, ${describe(v)}`}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-11 w-full cursor-pointer accent-[rgb(var(--accent))]"
        data-testid={testId}
      />
      <div className="flex justify-between text-xs text-ink-muted" aria-hidden="true">
        <span>Chưa chắc</span><span>Khá chắc</span><span>Rất chắc</span>
      </div>
    </div>
  );
}
