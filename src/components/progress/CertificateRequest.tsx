/**
 * Certificate request (POST /api/v1/certificates). Eligibility is decided by the server (403 with a
 * Vietnamese reason); the UI shows the likely state from the level and the server's answer verbatim.
 */
import { useId, useState } from 'react';
import { ApiError, api, friendlyMessage } from '../../lib/ui/api-client';

interface Props {
  levelId: string;
  levelName: string;
  defaultName: string;
  isMember: boolean;
}

export default function CertificateRequest({ levelId, levelName, defaultName, isMember }: Props) {
  const id = useId();
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const likelyEligible = levelId !== 'L0';

  async function request(e: { preventDefault: () => void }) {
    e.preventDefault();
    const displayName = name.trim();
    if (displayName.length < 2 || displayName.length > 60) {
      setError('Tên hiển thị cần từ 2 đến 60 ký tự.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestCertificate(displayName);
      setCode(res.code);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'forbidden'
        ? `Chưa đủ điều kiện nhận chứng nhận: ${err.message}`
        : friendlyMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (code) {
    return (
      <div className="flex flex-col gap-2" role="status" data-testid="certificate-ready">
        <p>🎓 Chứng nhận của bạn đã sẵn sàng!</p>
        <a href={`/certificates/${encodeURIComponent(code)}`} className="btn-primary">Xem và chia sẻ chứng nhận</a>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={request} noValidate>
      <p className="text-sm">
        Cấp hiện tại: <strong>{levelId} · {levelName}</strong>.{' '}
        {likelyEligible
          ? 'Bạn có thể nhận chứng nhận cho cấp này.'
          : 'Hoàn thành mission với bằng chứng đạt để lên L1, rồi quay lại nhận chứng nhận nhé.'}
      </p>
      {!isMember && <p className="text-xs text-ink-muted">Mẹo: đăng nhập với zuey.me trước để chứng nhận gắn với tài khoản của bạn.</p>}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="font-medium">Tên in trên chứng nhận</label>
        <input id={id} className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <button type="submit" className="btn-primary" disabled={busy} data-testid="certificate-request">
        {busy ? 'Đang tạo…' : 'Nhận chứng nhận'}
      </button>
    </form>
  );
}
