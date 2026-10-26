/** Browser checks shared by the install prompt and the reminder settings (iOS needs Home Screen install for push). */

/** Chromium's install prompt event (not in lib.dom). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const isStandalone = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone/iPad, including iPadOS that reports itself as a Mac with touch. */
export const isIos = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const pushSupported = (): boolean =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const IOS_INSTALL_STEPS = 'Trong Safari, chạm nút Chia sẻ (ô vuông có mũi tên lên) → “Thêm vào MH chính”, rồi mở AI Unlocked từ biểu tượng mới trên màn hình chính.';
