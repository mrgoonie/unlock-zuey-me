/** Horizontal probability bars drawn with divs (no chart library). Each row reads as text for screen readers. */
export interface BarItem {
  label: string;
  /** 0..1 */
  p: number;
  /** Visual + text marker, e.g. "bạn chọn". */
  tag?: string;
  strong?: boolean;
}

interface Props {
  items: BarItem[];
  caption?: string;
}

export const formatPercent = (p: number): string => `${Math.round(p * 100)}%`;

export default function ProbabilityBars({ items, caption }: Props) {
  return (
    <figure className="mt-3">
      {caption && <figcaption className="mb-2 text-sm text-ink-muted">{caption}</figcaption>}
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.label}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className={it.strong ? 'font-semibold' : undefined}>
                {it.label}
                {it.tag && <span className="chip ml-2 align-middle">{it.tag}</span>}
              </span>
              <span className="tabular-nums text-ink-muted">{formatPercent(it.p)}</span>
            </div>
            <div className="mt-1 h-3 w-full overflow-hidden rounded-full bg-line/60" aria-hidden="true">
              <div
                className={`h-full rounded-full transition-all duration-500 ${it.strong ? 'bg-accent' : 'bg-calm/70'}`}
                style={{ width: `${Math.max(it.p * 100, it.p > 0 ? 2 : 0)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </figure>
  );
}
