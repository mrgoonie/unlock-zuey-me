/**
 * One guessing round: pick the next word, say how sure you are (calibration), then reveal the authored
 * probability distribution.
 */
import { useState } from 'react';
import type { Prediction } from '../../lib/labs/calibration';
import { CONFIDENCE_LEVELS, type PredictRound } from '../../lib/labs/token-predictor-data';
import { normalise, topIndex } from '../../lib/labs/token-sampling';
import OptionButtons from './OptionButtons';
import ProbabilityBars from './ProbabilityBars';

interface Props {
  round: PredictRound;
  onDone: (prediction: Prediction) => void;
  isLast: boolean;
}

export default function TokenGuessRound({ round, onDone, isLast }: Props) {
  const [guess, setGuess] = useState<string>();
  const [confidence, setConfidence] = useState<number>();
  const [revealed, setRevealed] = useState(false);

  const dist = normalise(round.options);
  const aiPick = dist[topIndex(dist)].token;
  const ranked = [...dist].sort((a, b) => b.p - a.p);
  const correct = guess === aiPick;

  return (
    <div>
      <div className="card">
        <p className="text-sm text-ink-muted">Câu đang viết dở:</p>
        <p className="mt-1 text-lg font-semibold">
          “{round.prompt} <span className="rounded bg-accent/15 px-1.5 text-accent">{revealed ? aiPick : '___'}</span>”
        </p>
        <p className="mt-3 text-sm font-medium">1. Bạn đoán AI sẽ viết chữ nào tiếp theo?</p>
        <OptionButtons
          label="Chọn chữ tiếp theo"
          options={round.options.map((o) => ({ id: o.token, label: o.token }))}
          selected={guess}
          onSelect={setGuess}
          locked={revealed}
          correctIds={[aiPick]}
        />
        <p className="mt-4 text-sm font-medium">2. Bạn chắc chắn bao nhiêu?</p>
        <OptionButtons
          label="Mức độ chắc chắn"
          options={CONFIDENCE_LEVELS.map((c) => ({ id: String(c.value), label: c.label, sub: `${c.value}%` }))}
          selected={confidence === undefined ? undefined : String(confidence)}
          onSelect={(id) => setConfidence(Number(id))}
          locked={revealed}
        />
        {!revealed && (
          <button
            type="button"
            className="btn-primary mt-4 w-full"
            disabled={guess === undefined || confidence === undefined}
            onClick={() => setRevealed(true)}
          >
            Xem AI đoán gì
          </button>
        )}
      </div>

      <div aria-live="polite">
        {revealed && (
          <div className="card mt-4">
            <p className="font-semibold">
              {correct ? '🎯 Trùng với lựa chọn số 1 của AI!' : `AI hay chọn “${aiPick}” nhất.`}
            </p>
            <ProbabilityBars
              caption="Xác suất (số liệu minh hoạ, không đo từ mô hình thật)"
              items={ranked.map((o) => ({
                label: o.token,
                p: o.p,
                strong: o.token === aiPick,
                tag: o.token === guess ? 'bạn chọn' : undefined,
              }))}
            />
            <p className="mt-3 text-sm">{round.insight}</p>
            <button
              type="button"
              className="btn-primary mt-4 w-full"
              onClick={() => onDone({ confidence: confidence ?? 0, correct })}
            >
              {isLast ? 'Sang trò tung xúc xắc' : 'Câu tiếp theo'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
