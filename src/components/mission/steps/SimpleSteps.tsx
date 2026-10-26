/** Renderers for the text-only step types: intro, guided-input (text/textarea/list) and reflection. */
import ListField from '../../ui/ListField';
import TextField from '../../ui/TextField';
import { str, strList, type StepOf, type StepProps } from './step-props';

export function IntroStep({ step }: StepProps<StepOf<'intro'>>) {
  return <p className="whitespace-pre-line text-lg leading-relaxed">{step.body}</p>;
}

export function GuidedInputStep({ step, values, onField }: StepProps<StepOf<'guided-input'>>) {
  return (
    <div className="flex flex-col gap-5">
      <p className="leading-relaxed">{step.prompt}</p>
      {step.fields.map((f) =>
        f.kind === 'list' ? (
          <ListField
            key={f.id}
            label={f.label}
            value={strList(values[f.id])}
            onChange={(v) => onField(f.id, v)}
            placeholder={f.placeholder}
            min={f.required ? f.min : 0}
            testId={`field-${f.id}`}
          />
        ) : (
          <TextField
            key={f.id}
            label={f.required ? f.label : `${f.label} (không bắt buộc)`}
            value={str(values[f.id])}
            onChange={(v) => onField(f.id, v)}
            multiline={f.kind === 'textarea'}
            placeholder={f.placeholder}
            min={f.required ? f.min : 0}
            testId={`field-${f.id}`}
          />
        ),
      )}
    </div>
  );
}

export function ReflectionStep({ step, values, onField }: StepProps<StepOf<'reflection'>>) {
  return (
    <TextField
      label={step.prompt}
      value={str(values[step.field_id])}
      onChange={(v) => onField(step.field_id, v)}
      multiline
      rows={5}
      min={step.min}
      placeholder="Viết bằng lời của bạn, ngắn thôi cũng được."
      testId={`field-${step.field_id}`}
    />
  );
}
