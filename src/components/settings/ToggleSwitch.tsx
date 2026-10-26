/** Accessible on/off switch (role="switch", 44px target, keyboard via native button). */
interface Props {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

export default function ToggleSwitch({ id, label, description, checked, disabled, onChange }: Props) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <span id={`${id}-label`} className="font-medium">{label}</span>
        {description && <p id={`${id}-desc`} className="text-sm text-ink-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative inline-flex min-h-[44px] min-w-[56px] shrink-0 items-center justify-center disabled:opacity-50"
      >
        <span className={`h-7 w-12 rounded-full transition-colors ${checked ? 'bg-calm' : 'bg-line'}`} aria-hidden="true" />
        <span
          aria-hidden="true"
          className={`absolute h-6 w-6 rounded-full bg-surface shadow transition-transform ${checked ? 'translate-x-[10px]' : '-translate-x-[10px]'}`}
        />
        <span className="sr-only">{checked ? 'Đang bật' : 'Đang tắt'}</span>
      </button>
    </div>
  );
}
