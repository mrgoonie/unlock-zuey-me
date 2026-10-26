/**
 * Browser side of push reminders: permission, PushManager subscription and the /api/v1/push calls.
 * Notification.requestPermission is only ever called from a user tap (required by iOS and good manners).
 */
import type { PushStatus } from '../../lib/push/subscription-store';
import { apiRequest, SettingsApiError } from './settings-api';

export type { PushStatus };

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const browserTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Saigon';

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** This device's current push subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Asks permission (must run inside a tap handler), subscribes this device and stores it on the server. */
export async function enableReminders(remindTime: string): Promise<PushStatus> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new SettingsApiError('denied', 'Bạn chưa cho phép thông báo. Hãy bật quyền thông báo cho AI Unlocked trong cài đặt của trình duyệt hoặc điện thoại.');
  }
  const { key } = await apiRequest<{ key: string }>('/api/v1/push/public-key');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) });
  const { status } = await apiRequest<{ status: PushStatus }>('/api/v1/push/subscribe', 'POST', {
    subscription: sub.toJSON(), remindTime, timezone: browserTimezone(),
  });
  return status;
}

/** Unsubscribes this device in the browser and on the server. */
export async function disableRemindersOnDevice(): Promise<PushStatus> {
  const sub = await currentSubscription();
  if (!sub) return (await apiRequest<{ status: PushStatus }>('/api/v1/push/settings')).status;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  return (await apiRequest<{ status: PushStatus }>('/api/v1/push/unsubscribe', 'POST', { endpoint })).status;
}

export async function updateReminderSettings(input: { remindTime?: string; enabled?: boolean }): Promise<PushStatus> {
  return (await apiRequest<{ status: PushStatus }>('/api/v1/push/settings', 'PATCH', input)).status;
}
