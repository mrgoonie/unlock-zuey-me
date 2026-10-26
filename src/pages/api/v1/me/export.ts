/**
 * GET /api/v1/me/export: JSON attachment with the learner's data (bounded; see export-learner-data.ts).
 * GET /api/v1/me/export?table=<name>&after=<n>: the next page of one table listed in `continuation`.
 */
import type { APIRoute } from 'astro';
import { toErrorResponse } from '../../../../lib/http/api-response';
import { exportLearnerData, exportLearnerTablePage } from '../../../../lib/privacy/export-learner-data';
import { requireLearner } from '../../../../lib/privacy/learner-route-context';

const attachment = (data: unknown, filename: string) => new Response(JSON.stringify(data, null, 2), {
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  },
});

export const GET: APIRoute = async ({ locals, url }) => {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  try {
    const table = url.searchParams.get('table');
    if (table !== null) {
      const after = Number(url.searchParams.get('after') ?? '0');
      const page = await exportLearnerTablePage(ctx.env.DB, ctx.learner.id, table, after);
      // The table name is allow-listed by exportLearnerTablePage, so it is safe in the filename.
      return attachment(page, `ai-unlocked-du-lieu-${page.exportedAt.slice(0, 10)}-${page.table}-${after}.json`);
    }
    const data = await exportLearnerData(ctx.env.DB, ctx.env.EVIDENCE, ctx.learner.id);
    return attachment(data, `ai-unlocked-du-lieu-${data.exportedAt.slice(0, 10)}.json`);
  } catch (err) {
    return toErrorResponse(err);
  }
};
