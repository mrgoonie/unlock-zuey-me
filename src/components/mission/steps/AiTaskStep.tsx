/**
 * AI task step: copyable prompt suggestions, "Mở ChatGPT", optional in-app practice chat, the paste box for
 * the AI's answer and an optional screenshot upload.
 */
import { useRef, useState } from 'react';
import CopyButton from '../../ui/CopyButton';
import TextField from '../../ui/TextField';
import EvidenceImageUpload from './EvidenceImageUpload';
import PracticeChatDrawer from './PracticeChatDrawer';
import { str, type StepOf, type StepProps } from './step-props';

export default function AiTaskStep({ step, values, onField, runId, draft, patchDraft }: StepProps<StepOf<'ai-task'>>) {
  const [chatOpen, setChatOpen] = useState(false);
  const chatButton = useRef<HTMLButtonElement>(null);
  const answer = str(values[step.capture.id]);

  return (
    <div className="flex flex-col gap-5">
      <p className="leading-relaxed">{step.instruction}</p>

      <section aria-labelledby={`${step.id}-prompts`} className="flex flex-col gap-3">
        <h3 id={`${step.id}-prompts`} className="font-semibold">Câu lệnh gợi ý</h3>
        {step.prompt_suggestions.map((p, i) => (
          <figure key={i} className="card flex flex-col gap-2 bg-bg" data-testid="prompt-suggestion">
            <blockquote className="whitespace-pre-line text-sm leading-relaxed">{p}</blockquote>
            <figcaption className="text-xs text-ink-muted">Thay phần trong [ngoặc vuông] bằng thông tin của bạn.</figcaption>
            <CopyButton text={p} className="self-start" />
          </figure>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer" className="btn-ghost">
          Mở ChatGPT <span aria-hidden="true">↗</span><span className="sr-only">(mở tab mới)</span>
        </a>
        {step.allow_in_app_chat && (
          <button ref={chatButton} type="button" className="btn-ghost" onClick={() => setChatOpen(true)} data-testid="open-practice-chat">
            💬 Chat thử ngay trong app
          </button>
        )}
      </div>

      <TextField
        label={step.capture.label}
        value={answer}
        onChange={(v) => onField(step.capture.id, v)}
        multiline
        rows={7}
        min={step.capture.min}
        placeholder="Dán nguyên văn câu trả lời của AI vào đây…"
        testId={`field-${step.capture.id}`}
      />

      {step.capture.allow_image && (
        <EvidenceImageUpload
          keys={draft.imageKeys}
          onAdd={(key) => patchDraft((d) => ({ ...d, imageKeys: [...d.imageKeys, key] }))}
          onRemove={(key) => patchDraft((d) => ({ ...d, imageKeys: d.imageKeys.filter((k) => k !== key) }))}
        />
      )}

      {step.allow_in_app_chat && (
        <PracticeChatDrawer
          open={chatOpen}
          onClose={() => { setChatOpen(false); chatButton.current?.focus(); }}
          runId={runId}
          stepId={step.id}
          suggestions={step.prompt_suggestions}
          onUseReply={(reply) => onField(step.capture.id, answer.trim() ? `${answer.trim()}\n\n${reply}` : reply)}
        />
      )}
    </div>
  );
}
