/**
 * A group of large toggle buttons (single choice). Native buttons give keyboard support for free;
 * aria-pressed exposes the selection. After `locked`, choices are disabled and marked right/wrong.
 */
interface Option {
  id: string;
  label: string;
  sub?: string;
}

interface Props {
  label: string;
  options: Option[];
  selected?: string;
  onSelect: (id: string) => void;
  locked?: boolean;
  /** Ids to mark as correct once locked. */
  correctIds?: string[];
  columns?: 1 | 2;
}

export default function OptionButtons({ label, options, selected, onSelect, locked = false, correctIds = [], columns = 2 }: Props) {
  return (
    <div role="group" aria-label={label} className={`mt-3 grid gap-2 ${columns === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {options.map((o) => {
        const isSel = selected === o.id;
        const isRight = locked && correctIds.includes(o.id);
        const isWrong = locked && isSel && !isRight;
        const tone = isRight
          ? 'border-calm bg-calm/10'
          : isWrong
            ? 'border-danger bg-danger/10'
            : isSel
              ? 'border-accent bg-accent/10'
              : 'border-line bg-surface hover:bg-line/40';
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={isSel}
            disabled={locked}
            onClick={() => onSelect(o.id)}
            className={`min-h-[44px] rounded-xl border-2 px-3 py-2 text-left font-medium transition disabled:cursor-default ${tone}`}
          >
            <span className="block">
              {o.label}
              {isRight && <span className="sr-only"> (đáp án đúng)</span>}
              {isWrong && <span className="sr-only"> (chưa đúng)</span>}
            </span>
            {o.sub && <span className="block text-xs font-normal text-ink-muted">{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}
