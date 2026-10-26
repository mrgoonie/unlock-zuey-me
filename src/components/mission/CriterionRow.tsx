/** One rubric criterion: label, score bar (points out of its weight) and the grader's feedback. */
import type { CriterionResult } from '../../lib/learning/types';
import { COMPETENCY_LABEL, pct } from '../../lib/ui/labels';

interface Props {
  criterion: CriterionResult;
  action?: { label: string; onClick: () => void };
}

export default function CriterionRow({ criterion: c, action }: Props) {
  const percent = pct(c.score);
  const points = Math.round(c.score * c.weight * 10) / 10;
  const good = c.score >= 0.7;
  return (
    <div className="card flex flex-col gap-2" data-testid={`criterion-${c.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium">{c.label}</p>
        <p className={`shrink-0 text-sm font-semibold ${good ? 'text-calm' : 'text-warn'}`} data-testid="criterion-score">
          {points}/{c.weight}
        </p>
      </div>
      <div className="bar" role="progressbar" aria-label={`${c.label}: ${percent}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className={`bar-fill ${good ? '' : 'bg-warn'}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-ink-muted">
        {COMPETENCY_LABEL[c.competency]?.emoji} {COMPETENCY_LABEL[c.competency]?.name ?? c.competency}
        {c.method === 'ai' ? ' · chấm bởi AI theo hướng dẫn' : ' · chấm tự động'}
      </p>
      {c.feedback && <p className="text-sm">{c.feedback}</p>}
      {action && (
        <button type="button" className="btn-ghost self-start text-sm" onClick={action.onClick}>{action.label} →</button>
      )}
    </div>
  );
}
