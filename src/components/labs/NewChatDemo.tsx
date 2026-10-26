/** Part 3: a new chat starts with an empty table, so the AI "forgets" until you paste a summary. */
import { useState } from 'react';
import { CHECKS, NEW_CHAT } from '../../lib/labs/context-lab-data';
import ChatBubble from './ChatBubble';
import CheckQuestion from './CheckQuestion';

interface Props {
  onAnswered: (correct: boolean) => void;
  onNext: () => void;
}

export default function NewChatDemo({ onAnswered, onNext }: Props) {
  const [asked, setAsked] = useState(false);
  const [pasted, setPasted] = useState(false);

  return (
    <div>
      <div className="card space-y-2">
        <p className="text-xs font-medium text-ink-muted">✨ Cuộc trò chuyện mới · bàn trống trơn</p>
        {!asked && (
          <button type="button" className="btn-ghost w-full" onClick={() => setAsked(true)}>
            💬 Gửi: “{NEW_CHAT.ask}”
          </button>
        )}
        {asked && <ChatBubble role="user">{NEW_CHAT.ask}</ChatBubble>}
        <div aria-live="polite" className="space-y-2">
          {asked && <ChatBubble role="ai">{NEW_CHAT.blankAnswer}</ChatBubble>}
          {pasted && <ChatBubble role="user">{NEW_CHAT.summary}</ChatBubble>}
          {pasted && <ChatBubble role="ai">{NEW_CHAT.answerWithSummary}</ChatBubble>}
        </div>
        {asked && !pasted && (
          <>
            <p className="text-sm">Ơ, AI quên hết rồi! Chat mới không mang theo cuộc trò chuyện cũ (trừ khi ứng dụng có tính năng bộ nhớ).</p>
            <button type="button" className="btn-primary w-full" onClick={() => setPasted(true)}>
              📋 Dán bản tóm tắt
            </button>
          </>
        )}
      </div>

      {pasted && <CheckQuestion {...CHECKS.newChat} onAnswered={onAnswered} onNext={onNext} nextLabel="Xem kết quả" />}
    </div>
  );
}
