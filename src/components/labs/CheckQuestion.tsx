/** Multiple-choice check: pick once, see right/wrong + explanation (announced), then continue. */
import { useState } from 'react';
import OptionButtons from './OptionButtons';

interface Props {
  prompt: string;
  options: string[];
  correct: number;
  explain: string;
  onAnswered: (correct: boolean) => void;
  onNext: () => void;
  nextLabel?: string;
}

export default function CheckQuestion({ prompt, options, correct, explain, onAnswered, onNext, nextLabel = 'Tiếp tục' }: Props) {
  const [picked, setPicked] = useState<number | null>(null);
  const answered = picked !== null;
  const right = picked === correct;

  const choose = (id: string) => {
    if (answered) return;
    const idx = Number(id);
    setPicked(idx);
    onAnswered(idx === correct);
  };

  return (
    <section className="card mt-4" aria-label="Câu hỏi kiểm tra nhanh">
      <p className="font-semibold">🤔 {prompt}</p>
      <OptionButtons
        label={prompt}
        columns={1}
        options={options.map((label, i) => ({ id: String(i), label }))}
        selected={answered ? String(picked) : undefined}
        onSelect={choose}
        locked={answered}
        correctIds={[String(correct)]}
      />
      <div aria-live="polite">
        {answered && (
          <p className={`mt-3 text-sm ${right ? 'text-calm' : 'text-ink'}`}>
            <strong>{right ? 'Chuẩn luôn! ' : 'Chưa đúng lắm. '}</strong>
            {explain}
          </p>
        )}
      </div>
      {answered && (
        <button type="button" className="btn-primary mt-3 w-full" onClick={onNext}>
          {nextLabel}
        </button>
      )}
    </section>
  );
}
