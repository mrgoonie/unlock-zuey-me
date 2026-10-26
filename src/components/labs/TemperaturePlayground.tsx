/**
 * Temperature slider: re-weights one authored distribution and lets the learner "roll the dice" 10 times
 * to feel why the same question can get different answers.
 */
import { useId, useMemo, useState } from 'react';
import type { PredictRound } from '../../lib/labs/token-predictor-data';
import { applyTemperature, sampleIndex, topIndex } from '../../lib/labs/token-sampling';
import ProbabilityBars from './ProbabilityBars';

interface Props {
  round: PredictRound;
  onNext: () => void;
}

const ROLLS = 10;

function describe(t: number): string {
  if (t <= 0.3) return 'Rất "nghiêm túc": gần như lần nào cũng chọn chữ phổ biến nhất.';
  if (t <= 1.2) return 'Cân bằng: thường chọn chữ phổ biến, thỉnh thoảng đổi gió.';
  return 'Rất "bay bổng": chữ ít gặp cũng hay được chọn, dễ sáng tạo mà cũng dễ lạc đề.';
}

export default function TemperaturePlayground({ round, onNext }: Props) {
  const [temperature, setTemperature] = useState(1);
  const [rolls, setRolls] = useState<string[]>([]);
  const sliderId = useId();
  // Ranked by authored probability so the bars keep their order while the temperature changes.
  const ranked = useMemo(() => [...round.options].sort((a, b) => b.p - a.p), [round.options]);
  const dist = useMemo(() => applyTemperature(ranked, temperature), [ranked, temperature]);

  const roll = () => {
    const picks: string[] = [];
    for (let i = 0; i < ROLLS; i++) picks.push(dist[sampleIndex(dist, Math.random())].token);
    setRolls(picks);
  };

  return (
    <div className="card">
      <p className="text-sm">
        AI không luôn chọn chữ số 1. Nó <strong>tung xúc xắc có trọng số</strong>. Nút "nhiệt độ" (temperature) quyết định xúc
        xắc lệch tới đâu.
      </p>
      <p className="mt-3 font-semibold">“{round.prompt} ___”</p>
      <label htmlFor={sliderId} className="mt-4 block text-sm font-medium">
        Nhiệt độ: <span className="tabular-nums">{temperature.toFixed(1)}</span>
      </label>
      <input
        id={sliderId}
        type="range"
        min={0.1}
        max={2}
        step={0.1}
        value={temperature}
        onChange={(e) => {
          setTemperature(Number(e.target.value));
          setRolls([]);
        }}
        aria-valuetext={`${temperature.toFixed(1)}. ${describe(temperature)}`}
        className="mt-2 h-11 w-full accent-[rgb(var(--accent))]"
      />
      <div className="flex justify-between text-xs text-ink-muted" aria-hidden="true">
        <span>🧊 Lạnh</span>
        <span>🔥 Nóng</span>
      </div>
      <p className="mt-2 text-sm text-ink-muted">{describe(temperature)}</p>
      <ProbabilityBars items={dist.map((o, i) => ({ label: o.token, p: o.p, strong: i === topIndex(dist) }))} />
      <button type="button" className="btn-ghost mt-4 w-full" onClick={roll}>
        🎲 Cho AI đoán {ROLLS} lần
      </button>
      <div aria-live="polite">
        {rolls.length > 0 && (
          <p className="mt-3 text-sm">
            Kết quả {ROLLS} lần: <span className="font-medium">{rolls.join(', ')}</span>
          </p>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-muted">Thử kéo về 0.1 rồi lên 2.0 và đoán lại vài lần nhé.</p>
      <button type="button" className="btn-primary mt-4 w-full" onClick={onNext}>
        Tiếp: AI đọc chữ thế nào?
      </button>
    </div>
  );
}
