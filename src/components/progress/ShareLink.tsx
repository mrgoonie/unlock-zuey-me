/** Share a public URL with the Web Share API, falling back to copying the link. */
import { useState } from 'react';

export default function ShareLink({ url, title, text }: { url: string; title: string; text: string }) {
  const [note, setNote] = useState<string | null>(null);

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setNote('Đã sao chép đường dẫn.');
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setNote('Chưa chia sẻ được, hãy sao chép đường dẫn ở thanh địa chỉ.');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setNote('Đã sao chép đường dẫn.');
    } catch {
      setNote('Chưa sao chép được, hãy sao chép đường dẫn ở thanh địa chỉ.');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" className="btn-primary flex-1" onClick={share} data-testid="certificate-share">📣 Chia sẻ</button>
        <button type="button" className="btn-ghost flex-1" onClick={copy}>🔗 Sao chép đường dẫn</button>
      </div>
      <p className="text-center text-sm text-ink-muted" role="status">{note ?? ''}</p>
    </div>
  );
}
