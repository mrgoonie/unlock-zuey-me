/** Sound effects (default off) and reduced motion toggles, saved via PATCH /api/v1/me/profile (engine module). */
import { useState } from 'react';
import { apiRequest, errorMessage } from './settings-api';
import ToggleSwitch from './ToggleSwitch';

interface Props {
  sound: boolean;
  reducedMotion: boolean;
}
type Key = keyof Props;

export default function PreferenceToggles(initial: Props) {
  const [prefs, setPrefs] = useState<Props>(initial);
  const [saving, setSaving] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyMotion = (on: boolean) => {
    if (on) document.documentElement.dataset.reducedMotion = 'true';
    else delete document.documentElement.dataset.reducedMotion;
  };

  const save = async (key: Key, value: boolean) => {
    const previous = prefs[key];
    setPrefs((p) => ({ ...p, [key]: value }));
    if (key === 'reducedMotion') applyMotion(value);
    setSaving(key);
    setError(null);
    try {
      await apiRequest('/api/v1/me/profile', 'PATCH', { profile: { [key]: value } });
    } catch (err) {
      setPrefs((p) => ({ ...p, [key]: previous }));
      if (key === 'reducedMotion') applyMotion(previous);
      setError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ToggleSwitch id="pref-sound" label="Âm thanh" description="Tiếng “ting” nhỏ khi hoàn thành bước hoặc nhận huy hiệu."
        checked={prefs.sound} disabled={saving === 'sound'} onChange={(v) => save('sound', v)} />
      <ToggleSwitch id="pref-motion" label="Giảm chuyển động" description="Tắt hiệu ứng chuyển động và hoạt ảnh ăn mừng."
        checked={prefs.reducedMotion} disabled={saving === 'reducedMotion'} onChange={(v) => save('reducedMotion', v)} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
