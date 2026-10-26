/** Client fetch helper for settings islands: JSON in/out, API error messages surfaced in Vietnamese. */

export class SettingsApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function apiRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new SettingsApiError('network', 'Không kết nối được. Kiểm tra mạng rồi thử lại nhé.');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) {
    throw new SettingsApiError(data?.error?.code ?? 'internal', data?.error?.message ?? 'Có lỗi xảy ra, thử lại sau nhé.');
  }
  return data as T;
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Có lỗi xảy ra, thử lại sau nhé.';
