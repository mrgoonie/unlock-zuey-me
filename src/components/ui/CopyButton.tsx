/** Copies text to the clipboard with a polite confirmation. Falls back to a hidden textarea when needed. */
import { useState } from 'react';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export default function CopyButton({ text, label = 'Sao chép', className = '' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      type="button"
      className={`btn-ghost min-h-[44px] text-sm ${className}`}
      onClick={async () => {
        setState((await copyText(text)) ? 'ok' : 'fail');
        setTimeout(() => setState('idle'), 2000);
      }}
    >
      <span aria-hidden="true">{state === 'ok' ? '✅' : '📋'}</span>
      <span aria-live="polite">{state === 'ok' ? 'Đã sao chép' : state === 'fail' ? 'Hãy chọn và sao chép thủ công' : label}</span>
    </button>
  );
}
