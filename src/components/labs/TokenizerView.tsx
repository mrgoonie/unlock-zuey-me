/** Tokenizer view: split any text into approximate tokens and compare Vietnamese with English. */
import { useId, useMemo, useState } from 'react';
import { TOKENIZER_SAMPLES } from '../../lib/labs/token-predictor-data';
import { tokenizeApprox } from '../../lib/labs/tokenizer-approx';

interface Props {
  onNext: () => void;
}

const TONES = ['bg-accent/15', 'bg-calm/15', 'bg-warn/20'];
const MAX_CHARS = 280;

export default function TokenizerView({ onNext }: Props) {
  const [text, setText] = useState(TOKENIZER_SAMPLES[0].text);
  const fieldId = useId();
  const tokens = useMemo(() => tokenizeApprox(text), [text]);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="card">
      <p className="text-sm">
        AI không đọc từng chữ cái hay từng từ. Nó cắt chữ thành những <strong>mẩu nhỏ gọi là token</strong>. Tiếng Việt có dấu
        thường bị cắt vụn hơn tiếng Anh, nên tốn nhiều token hơn.
      </p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Câu mẫu">
        {TOKENIZER_SAMPLES.map((s) => (
          <button key={s.label} type="button" className="btn-ghost text-sm" aria-pressed={text === s.text} onClick={() => setText(s.text)}>
            {s.label}
          </button>
        ))}
      </div>
      <label htmlFor={fieldId} className="mt-3 block text-sm font-medium">
        Hoặc gõ câu của bạn
      </label>
      <textarea
        id={fieldId}
        className="field mt-1"
        rows={2}
        maxLength={MAX_CHARS}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="mt-3 text-sm font-medium" aria-live="polite">
        {words} từ → khoảng <span className="tabular-nums">{tokens.length}</span> token
      </p>
      <p className="mt-2 flex flex-wrap gap-y-1 font-mono text-sm" aria-label="Các token">
        {tokens.map((t) => (
          <span key={t.index} className={`whitespace-pre rounded px-0.5 ${TONES[t.index % TONES.length]}`}>
            {t.text}
          </span>
        ))}
      </p>
      <p className="mt-3 text-xs text-ink-muted">
        ⚠️ Đây là mô phỏng gần đúng cho dễ hình dung. Mỗi AI thật có bộ cắt token riêng, con số thật sẽ khác.
      </p>
      <button type="button" className="btn-primary mt-4 w-full" onClick={onNext}>
        Xem kết quả
      </button>
    </div>
  );
}
