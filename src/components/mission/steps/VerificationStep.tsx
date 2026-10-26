/**
 * Verification step: one radio group per claim (four trust verdicts) plus notes on what the learner checked.
 * Explanations are not shown here: the verdicts are graded, the reference answers appear after passing.
 */
import TextField from '../../ui/TextField';
import { str, type StepOf, type StepProps } from './step-props';

export const VERDICTS = [
  { id: 'verified', label: 'Tin có căn cứ', emoji: '✅' },
  { id: 'needs_lookup', label: 'Cần tra cứu', emoji: '🔍' },
  { id: 'insufficient', label: 'Không đủ dữ liệu', emoji: '❔' },
  { id: 'expert', label: 'Cần chuyên gia', emoji: '🧑‍⚕️' },
] as const;

export default function VerificationStep({ step, values, onField }: StepProps<StepOf<'verification'>>) {
  return (
    <div className="flex flex-col gap-5">
      <p className="leading-relaxed">{step.instruction}</p>
      {step.claims.map((c, i) => (
        <fieldset key={c.id} className="card flex flex-col gap-2" data-testid={`claim-${c.id}`}>
          <legend className="sr-only">Nhận định {i + 1}</legend>
          <p className="font-medium" aria-hidden="true">“{c.text}”</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {VERDICTS.map((v) => (
              <label key={v.id} className="choice">
                <input
                  type="radio"
                  name={`${step.id}-${c.id}`}
                  value={v.id}
                  checked={values[c.id] === v.id}
                  onChange={() => onField(c.id, v.id)}
                  aria-label={`“${c.text}”: ${v.label}`}
                  className="h-5 w-5 accent-[rgb(var(--accent))]"
                />
                <span aria-hidden="true">{v.emoji}</span>
                <span>{v.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <TextField
        label={step.notes.label}
        value={str(values[step.notes.id])}
        onChange={(v) => onField(step.notes.id, v)}
        multiline
        min={step.notes.min}
        placeholder="Ví dụ: AI nói quán mở 7h, Google Maps ghi 7h30…"
        testId={`field-${step.notes.id}`}
      />
    </div>
  );
}
