/**
 * JSON helpers for /api/v1 routes. Every error has the shape {error: {code, message}} so the UI and tests
 * can branch on `code` without parsing text.
 */
import { z } from 'zod';
import { LearningError } from '../learning/types';

export type ApiErrorCode =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid'
  | 'rate_limited' | 'budget_exceeded' | 'unavailable' | 'internal';

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, invalid: 400,
  rate_limited: 429, budget_exceeded: 429, unavailable: 503, internal: 500,
};

export const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

export const apiError = (code: ApiErrorCode, message: string): Response =>
  json({ error: { code, message } }, STATUS[code]);

/** Parses a JSON body with a zod schema; returns the data or a ready 400 response. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<{ data: T } | { response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { response: apiError('invalid', 'Body must be JSON') };
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { response: apiError('invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')) };
  return { data: r.data };
}

/** Maps thrown errors to API responses; unknown errors are logged and hidden. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof LearningError) return apiError(err.code, err.message);
  console.error('unhandled api error', err);
  return apiError('internal', 'Có lỗi không mong muốn. Bài làm của bạn vẫn được giữ.');
}
