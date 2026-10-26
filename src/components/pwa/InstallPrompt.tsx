/**
 * "Cài app" banner. Android/desktop Chromium: native install prompt from beforeinstallprompt.
 * iOS Safari: step-by-step "Add to Home Screen" instructions (also required for push on iOS 16.4+).
 * Hidden when already installed or dismissed (remembered per device).
 */
import { useEffect, useState } from 'react';
import { IOS_INSTALL_STEPS, isIos, isStandalone, type BeforeInstallPromptEvent } from './install-platform';

const DISMISS_KEY = 'aiu.installPrompt.dismissed';

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIos, setShowIos] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      // Storage blocked (private mode): just show the prompt.
    }
    if (dismissed || isStandalone()) return;
    setHidden(false);
    if (isIos()) setShowIos(true);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setHidden(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Ignore: the banner simply comes back next visit.
    }
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    if (outcome === 'accepted') setHidden(true);
  };

  if (hidden || (!deferred && !showIos)) return null;

  return (
    <aside aria-label="Cài ứng dụng" className="card mx-auto mb-3 flex max-w-2xl flex-col gap-2 text-sm">
      <p className="font-semibold">📲 Cài AI Unlocked lên màn hình chính</p>
      {deferred ? (
        <p className="text-ink-muted">Mở nhanh như một ứng dụng và nhận nhắc nhở nhẹ nhàng mỗi ngày.</p>
      ) : (
        <p className="text-ink-muted">{IOS_INSTALL_STEPS} Cần iOS 16.4 trở lên để nhận nhắc nhở.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {deferred && <button type="button" className="btn-primary" onClick={install}>Cài ngay</button>}
        <button type="button" className="btn-ghost" onClick={dismiss}>Để sau</button>
      </div>
    </aside>
  );
}
