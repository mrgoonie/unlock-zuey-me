/** Opening card for every lab: what you will learn, how long it takes, and a start button. */
import type { LabMeta } from '../../lib/labs/registry';

interface Props {
  lab: LabMeta;
  bullets: string[];
  onStart: () => void;
}

export default function LabIntro({ lab, bullets, onStart }: Props) {
  return (
    <section className="card mt-2">
      <p className="text-5xl" aria-hidden="true">
        {lab.emoji}
      </p>
      <h2 className="mt-2 text-xl font-bold">{lab.title}</h2>
      <p className="mt-1 text-ink-muted">{lab.summary}</p>
      <ul className="mt-3 space-y-1 text-sm">
        {bullets.map((b) => (
          <li key={b} className="flex gap-2">
            <span aria-hidden="true">✨</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-ink-muted">Khoảng {lab.minutes} phút · Không cần mạng, không có AI thật, cứ thoải mái thử.</p>
      <button type="button" className="btn-primary mt-4 w-full" onClick={onStart}>
        Bắt đầu thôi
      </button>
    </section>
  );
}
