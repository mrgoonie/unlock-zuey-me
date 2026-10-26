/** Screenshot evidence upload (POST /api/v1/evidence/upload). Images only, ≤ 5 MB, validated before upload. */
import { useId, useState } from 'react';
import { api, friendlyMessage } from '../../../lib/ui/api-client';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;

interface Props {
  keys: string[];
  onAdd: (key: string) => void;
  onRemove: (key: string) => void;
}

export default function EvidenceImageUpload({ keys, onAdd, onRemove }: Props) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});

  async function onFile(file: File | undefined) {
    setMessage(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) return setMessage('Chỉ nhận ảnh (ảnh chụp màn hình, JPG, PNG…).');
    if (file.size > MAX_BYTES) return setMessage('Ảnh lớn hơn 5 MB. Hãy chụp lại hoặc cắt bớt ảnh nhé.');
    setBusy(true);
    try {
      const { key } = await api.uploadEvidence(file);
      setPreviews((p) => ({ ...p, [key]: URL.createObjectURL(file) }));
      onAdd(key);
      setMessage('Đã tải ảnh lên.');
    } catch (e) {
      setMessage(`Chưa tải được ảnh: ${friendlyMessage(e)} Bạn vẫn có thể dán chữ ở ô trên.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">Ảnh chụp màn hình (không bắt buộc)</p>
      {keys.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {keys.map((k, i) => (
            <li key={k} className="relative mr-2 mt-2">
              <img src={previews[k] ?? `/api/v1/evidence/${encodeURIComponent(k)}`} alt={`Ảnh bằng chứng ${i + 1}`}
                className="h-20 w-20 rounded-xl border border-line bg-bg object-cover" />
              <button type="button" onClick={() => onRemove(k)} aria-label={`Bỏ ảnh ${i + 1}`}
                className="absolute -right-3 -top-3 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-sm">✕</button>
            </li>
          ))}
        </ul>
      )}
      {keys.length < MAX_FILES && (
        <div className="self-start">
          {/* Visually hidden input stays focusable; `peer-focus-visible` paints the ring on the visible label. */}
          <input id={id} type="file" accept="image/*" className="peer sr-only" disabled={busy} data-testid="evidence-upload"
            onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
          <label htmlFor={id}
            className={`btn-ghost cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-accent ${busy ? 'pointer-events-none opacity-60' : ''}`}>
            📷 {busy ? 'Đang tải ảnh…' : 'Thêm ảnh chụp'}
          </label>
        </div>
      )}
      <p className="text-xs text-ink-muted" aria-live="polite">{message ?? 'Che bớt thông tin cá nhân trước khi chụp nếu có.'}</p>
    </div>
  );
}
