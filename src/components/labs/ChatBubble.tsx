/** One chat message in the fake AI conversations. `faded` marks messages that fell out of the context window. */
import type { ReactNode } from 'react';

interface Props {
  role: 'user' | 'ai';
  children: ReactNode;
  faded?: boolean;
}

export default function ChatBubble({ role, children, faded = false }: Props) {
  const mine = role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm transition-opacity duration-300 ${
          mine ? 'rounded-br-sm bg-accent/15' : 'rounded-bl-sm border border-line bg-surface'
        } ${faded ? 'opacity-40 line-through decoration-ink-muted/60' : ''}`}
      >
        <span className="sr-only">{mine ? 'Bạn: ' : 'AI: '}</span>
        <span aria-hidden="true" className="mr-1">
          {mine ? '🙋‍♀️' : '🤖'}
        </span>
        {children}
        {faded && <span className="mt-1 block text-xs text-ink-muted no-underline">(đã rơi khỏi bàn)</span>}
      </div>
    </div>
  );
}
