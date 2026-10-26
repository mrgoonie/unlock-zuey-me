/**
 * Observer consent: explains exactly what an observer (AI Unlocked admin) sees, and grants/revokes access
 * via PATCH /api/v1/me/consent. Revoking hides everything from the dashboard immediately.
 */
import { useState } from 'react';
import { apiRequest, errorMessage } from './settings-api';
import ToggleSwitch from './ToggleSwitch';

const SEES = [
  'Dòng thời gian hoạt động: lúc bạn bắt đầu, xem, hoàn thành từng bước mission, xin gợi ý, nộp bài.',
  'Bài đã nộp: câu trả lời và ảnh chụp màn hình bạn gửi làm bằng chứng.',
  'Điểm theo từng tiêu chí, mức độ tự tin bạn dự đoán trước khi chấm, và năng lực theo 6 nhóm.',
  'Tin nhắn giữa bạn và trợ lý (gợi ý và chat luyện tập) trong app.',
  'Tên hiển thị, XP, số mission đã xong và lần hoạt động gần nhất.',
];
const NOT_SEES = 'Không thấy: email, mật khẩu, bản nháp chưa nộp, và mọi thứ bạn làm bên ngoài AI Unlocked.';

export default function ObserverConsentToggle({ initial }: { initial: boolean }) {
  const [consent, setConsent] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const change = async (next: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await apiRequest<{ observerConsent: boolean }>('/api/v1/me/consent', 'PATCH', { observer: next });
      setConsent(r.observerConsent);
      setMessage({
        kind: 'ok',
        text: r.observerConsent ? 'Đã cho phép quan sát. Bạn có thể tắt bất cứ lúc nào.' : 'Đã tắt. Người quan sát không còn thấy gì về hành trình của bạn.',
      });
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ToggleSwitch id="observer-consent" label="Cho phép người quan sát xem hành trình học"
        description="Người quan sát là quản trị viên AI Unlocked, giúp cải thiện bài học. Mặc định tắt."
        checked={consent} disabled={busy} onChange={change} />
      <details className="rounded-xl bg-line/40 p-3 text-sm">
        <summary className="cursor-pointer font-medium min-h-[44px] flex items-center">Người quan sát sẽ thấy gì?</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {SEES.map((s) => <li key={s}>{s}</li>)}
        </ul>
        <p className="mt-2">{NOT_SEES}</p>
        <p className="mt-2">Khi bạn tắt, mọi thứ bị ẩn ngay ở lần xem tiếp theo. Tắt không xoá dữ liệu; muốn xoá hẳn, dùng mục “Xoá dữ liệu” bên dưới.</p>
      </details>
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-danger' : 'text-calm'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
