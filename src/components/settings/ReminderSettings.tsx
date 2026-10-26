/** Daily reminder settings: enable (permission from a tap), choose HH:MM, see status, turn off. */
import { useEffect, useState } from 'react';
import { IOS_INSTALL_STEPS, isIos, isStandalone, pushSupported } from '../pwa/install-platform';
import { currentSubscription, disableRemindersOnDevice, enableReminders, updateReminderSettings, type PushStatus } from './push-client';
import { errorMessage } from './settings-api';

type Support = 'checking' | 'ok' | 'ios-install' | 'unsupported';

export default function ReminderSettings({ initial }: { initial: PushStatus }) {
  const [status, setStatus] = useState(initial);
  const [time, setTime] = useState(initial.remindTime);
  const [support, setSupport] = useState<Support>('checking');
  const [onDevice, setOnDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!pushSupported()) {
      setSupport(isIos() && !isStandalone() ? 'ios-install' : 'unsupported');
      return;
    }
    setSupport('ok');
    currentSubscription().then((s) => setOnDevice(Boolean(s))).catch(() => setOnDevice(false));
  }, []);

  const run = async (action: () => Promise<PushStatus>, okText: string, device?: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await action();
      setStatus(next);
      if (device !== undefined) setOnDevice(device);
      setMessage({ kind: 'ok', text: okText });
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const activeHere = onDevice && status.enabled;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm" aria-live="polite">
        {activeHere
          ? `Đang bật trên thiết bị này · nhắc lúc ${status.remindTime} (${status.timezone}).`
          : status.enabled && status.devices > 0
            ? `Đang bật trên ${status.devices} thiết bị khác · nhắc lúc ${status.remindTime}.`
            : 'Đang tắt. Bật để nhận một lời nhắc nhẹ mỗi ngày, chỉ khi hôm đó bạn chưa học.'}
      </p>

      {support === 'ios-install' && (
        <p className="rounded-xl bg-line/40 p-3 text-sm">Trên iPhone/iPad, nhắc nhở chỉ hoạt động khi đã cài app (iOS 16.4+). {IOS_INSTALL_STEPS}</p>
      )}
      {support === 'unsupported' && (
        <p className="rounded-xl bg-line/40 p-3 text-sm">Trình duyệt này chưa hỗ trợ thông báo đẩy. Hãy thử Chrome, Edge, Firefox hoặc Safari mới.</p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm font-medium" htmlFor="remind-time">
          Giờ nhắc
          <input id="remind-time" type="time" className="field min-h-[44px] w-36" value={time} required
            onChange={(e) => setTime(e.target.value)} disabled={busy} />
        </label>
        {status.devices > 0 && time !== status.remindTime && (
          <button type="button" className="btn-ghost" disabled={busy || !/^\d{2}:\d{2}$/.test(time)}
            onClick={() => run(() => updateReminderSettings({ remindTime: time }), `Đã đổi giờ nhắc sang ${time}.`)}>
            Lưu giờ
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {support === 'ok' && !activeHere && (
          <button type="button" className="btn-primary" disabled={busy}
            onClick={() => run(() => enableReminders(time), 'Đã bật nhắc nhở. Hẹn gặp bạn vào giờ đã chọn!', true)}>
            🔔 Bật nhắc nhở trên thiết bị này
          </button>
        )}
        {support === 'ok' && onDevice && (
          <button type="button" className="btn-ghost" disabled={busy}
            onClick={() => run(disableRemindersOnDevice, 'Đã tắt nhắc nhở trên thiết bị này.', false)}>
            Tắt trên thiết bị này
          </button>
        )}
        {status.enabled && status.devices > (onDevice ? 1 : 0) && (
          <button type="button" className="btn-ghost" disabled={busy}
            onClick={() => run(() => updateReminderSettings({ enabled: false }), 'Đã tắt nhắc nhở trên mọi thiết bị.')}>
            Tắt trên mọi thiết bị
          </button>
        )}
      </div>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-danger' : 'text-calm'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
