/**
 * /start: up to three skippable questions with big choice cards. Answers are saved with
 * PATCH /api/v1/me/profile, then the learner lands on /home. Saving failures never block: we still go on.
 */
import { useEffect, useRef, useState } from 'react';
import type { LearnerProfile } from '../../lib/learning/types';
import { api } from '../../lib/ui/api-client';
import { ONBOARDING_QUESTIONS } from '../../lib/ui/labels';

type Key = keyof typeof ONBOARDING_QUESTIONS;
const ORDER: Key[] = ['goal', 'familiarity', 'obstacle'];

export default function OnboardingFlow({ initial }: { initial: Partial<LearnerProfile> }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Partial<Record<Key, string>>>({
    goal: initial.goal, familiarity: initial.familiarity, obstacle: initial.obstacle,
  });
  const [saving, setSaving] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const key = ORDER[index];
  const q = ONBOARDING_QUESTIONS[key];

  useEffect(() => {
    if (index > 0) headingRef.current?.focus();
  }, [index]);

  async function finish(final: Partial<Record<Key, string>>, skipped: boolean) {
    setSaving(true);
    const profile = Object.fromEntries(Object.entries(final).filter(([, v]) => v)) as Partial<LearnerProfile>;
    try {
      if (Object.keys(profile).length) await api.updateProfile({ profile });
    } catch {
      /* onboarding is optional: never trap the learner here */
    }
    void api.event(skipped && !Object.keys(profile).length ? 'onboarding.skipped' : 'onboarding.completed');
    window.location.assign('/home');
  }

  function choose(value: string) {
    const next = { ...answers, [key]: value };
    setAnswers(next);
    if (index < ORDER.length - 1) setIndex(index + 1);
    else void finish(next, false);
  }

  return (
    <section aria-labelledby="onb-q" className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted" aria-live="polite">Câu {index + 1}/{ORDER.length}</p>
        <button type="button" className="btn-ghost min-h-[44px] text-sm" disabled={saving} onClick={() => finish(answers, true)}>
          Bỏ qua
        </button>
      </div>
      <div className="flex gap-1.5" aria-hidden="true">
        {ORDER.map((k, i) => (
          <span key={k} className={`h-1.5 flex-1 rounded-full ${i <= index ? 'bg-accent' : 'bg-line'}`} />
        ))}
      </div>
      <h1 id="onb-q" ref={headingRef} tabIndex={-1} className="text-2xl font-bold leading-snug outline-none">{q.title}</h1>
      <div role="radiogroup" aria-labelledby="onb-q" className="flex flex-col gap-3">
        {q.options.map((o) => {
          const selected = answers[key] === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={saving}
              onClick={() => choose(o.value)}
              data-testid={`onboarding-option-${o.value}`}
              className={`card flex min-h-[72px] items-center gap-4 text-left transition hover:border-accent ${selected ? 'border-accent ring-2 ring-accent/30' : ''}`}
            >
              <span aria-hidden="true" className="text-3xl">{o.emoji}</span>
              <span className="flex flex-col">
                <span className="font-semibold">{o.label}</span>
                <span className="text-sm text-ink-muted">{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3">
        {index > 0 ? (
          <button type="button" className="btn-ghost" onClick={() => setIndex(index - 1)} disabled={saving}>← Quay lại</button>
        ) : <span />}
        {index < ORDER.length - 1 && (
          <button type="button" className="btn-ghost" onClick={() => setIndex(index + 1)} disabled={saving}>Câu sau →</button>
        )}
      </div>
      {saving && <p role="status" className="text-center text-ink-muted">Đang chuẩn bị hành trình cho bạn…</p>}
      <p className="text-center text-sm text-ink-muted">Không có câu trả lời sai. Bạn có thể đổi lại trong Cài đặt.</p>
    </section>
  );
}
