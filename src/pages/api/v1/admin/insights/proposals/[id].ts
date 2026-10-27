/**
 * GET   /api/v1/admin/insights/proposals/:id → detail with the fresh gate, the draft, monitoring and
 *       `issueMarkdown` (privacy-checked, for "Sao chép nội dung issue"; null while blocked).
 * PATCH /api/v1/admin/insights/proposals/:id {action, …} → triage:
 *       accept | reject | mark_duplicate {duplicateOf?} | mark_shipped {shippedRef?} | reopen
 *       file_issue (409 while GitHub filing is off or the token is missing)
 *       approve_ai_handle {confirm: "AI-HANDLE", confirmHighRisk?: true for high risk}
 *       Invalid transitions answer 409. Admin only; 404 for everyone else and while INSIGHTS_MODE=off, and for
 *       a proposal hidden from operators (no issue and fewer than 3 established consenting learners).
 *       `file_issue` is the only way an issue is ever created. `accept` and `approve_ai_handle` first store the
 *       draft the current evidence supports, so the decision applies to that text and is voided if it changes.
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { apiError, json, readBody, toErrorResponse } from '../../../../../../lib/http/api-response';
import { githubIssuesMode } from '../../../../../../lib/insights/feature-flags';
import { AI_HANDLE_LABEL, createGithubIssuePublisher } from '../../../../../../lib/insights/github-issue-publisher';
import { syncProposalDraft } from '../../../../../../lib/insights/proposal-assessment';
import { fileProposal, proposalDetail, type FilingOutcome } from '../../../../../../lib/insights/proposal-stage';
import {
  applyTriage, approveAiHandle, getProposalWithSignal, setAiHandleLabelled, type TriageAction,
} from '../../../../../../lib/insights/proposal-store';
import { requireInsightsAdmin } from './_insights-admin-gate';

const ref = z.string().trim().min(1).max(300);
const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }).strict(),
  z.object({ action: z.literal('reject') }).strict(),
  z.object({ action: z.literal('reopen') }).strict(),
  z.object({ action: z.literal('mark_duplicate'), duplicateOf: ref.optional() }).strict(),
  z.object({ action: z.literal('mark_shipped'), shippedRef: ref.optional() }).strict(),
  z.object({ action: z.literal('file_issue') }).strict(),
  z.object({ action: z.literal('approve_ai_handle'), confirm: z.literal('AI-HANDLE'), confirmHighRisk: z.literal(true).optional() }).strict(),
]);

const ID_RE = /^prp_[a-z0-9]{1,40}$/;
const GITHUB_OFF_MESSAGE = 'Chưa bật tạo issue GitHub (INSIGHTS_GITHUB_ISSUES đang tắt hoặc chưa cấu hình GITHUB_ISSUES_TOKEN). Hãy dùng “Sao chép nội dung issue” để tạo thủ công.';
const NOT_FOUND = () => apiError('not_found', 'Không tìm thấy.');

const FILING_ERRORS: Partial<Record<FilingOutcome['kind'], [code: 'conflict' | 'unavailable' | 'not_found', message: string]>> = {
  github_off: ['conflict', GITHUB_OFF_MESSAGE],
  not_found: ['not_found', 'Không tìm thấy.'],
  invalid_status: ['conflict', 'Đề xuất này không ở trạng thái có thể tạo issue.'],
  busy: ['conflict', 'Đang có một lượt tạo issue khác cho đề xuất này. Thử lại sau ít phút.'],
  operator_required: ['conflict', 'Chỉ người vận hành mới tạo được issue.'],
  privacy_blocked: ['conflict', 'Nội dung issue chưa qua kiểm tra quyền riêng tư nên không thể tạo issue.'],
  not_allowed: ['conflict', 'Chính sách chưa cho phép tạo issue cho đề xuất này (cần từ 3 người học đã đồng ý và bằng chứng đủ tin cậy).'],
  released: ['conflict', 'Lượt tạo issue trước bị gián đoạn và GitHub chưa có issue này. Đề xuất đã trở lại trạng thái trước, hãy thử lại.'],
  daily_cap: ['conflict', 'Đã đạt giới hạn số issue được tạo trong hôm nay. Thử lại vào ngày mai.'],
  github_error: ['unavailable', 'GitHub đang lỗi hoặc không phản hồi. Đề xuất được giữ nguyên, thử lại sau.'],
};

export const GET: APIRoute = async ({ locals, params }) => {
  const ctx = requireInsightsAdmin(locals);
  if (ctx instanceof Response) return ctx;
  const id = params.id ?? '';
  if (!ID_RE.test(id)) return NOT_FOUND();
  try {
    const detail = await proposalDetail(ctx.env, id, new Date());
    return detail ? json(detail) : NOT_FOUND();
  } catch (err) {
    return toErrorResponse(err);
  }
};

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const ctx = requireInsightsAdmin(locals);
  if (ctx instanceof Response) return ctx;
  const id = params.id ?? '';
  if (!ID_RE.test(id)) return NOT_FOUND();
  const body = await readBody(request, patchSchema);
  if ('response' in body) return body.response;
  const input = body.data;
  const { env, learner } = ctx;
  const now = new Date();
  try {
    if (!(await getProposalWithSignal(env.DB, id, { visibleOnly: true }))) return NOT_FOUND();
    if (input.action === 'accept' || input.action === 'approve_ai_handle') await syncProposalDraft(env, id, now);

    if (input.action === 'file_issue') {
      if (githubIssuesMode(env) === 'off') return apiError('conflict', GITHUB_OFF_MESSAGE);
      const outcome = await fileProposal(env, id, now, { operator: true, actor: learner.id });
      const error = FILING_ERRORS[outcome.kind];
      if (error) return apiError(error[0], error[1]);
    } else if (input.action === 'approve_ai_handle') {
      const detail = await proposalDetail(env, id, now);
      if (!detail) return NOT_FOUND();
      if (detail.proposal.risk === 'high' && input.confirmHighRisk !== true) {
        return apiError('invalid', 'Đề xuất rủi ro cao: cần xác nhận thêm confirmHighRisk để gắn ai-handle.');
      }
      if (githubIssuesMode(env) !== 'issues_ai_handle') {
        return apiError('conflict', 'Chế độ ai-handle chưa bật (INSIGHTS_GITHUB_ISSUES phải là issues_ai_handle và có GITHUB_ISSUES_TOKEN).');
      }
      if (!detail.issueMarkdown) return apiError('conflict', 'Nội dung issue chưa qua kiểm tra quyền riêng tư nên không thể gắn ai-handle.');
      if (!(await approveAiHandle(env.DB, id, learner.id, now))) {
        return apiError('conflict', 'Đề xuất này không ở trạng thái có thể duyệt ai-handle.');
      }
      if (detail.proposal.issue && !detail.proposal.aiHandle) {
        const publisher = createGithubIssuePublisher(env);
        try {
          await publisher?.addLabels(detail.proposal.issue.number, [AI_HANDLE_LABEL]);
          await setAiHandleLabelled(env.DB, id, now);
        } catch {
          return apiError('unavailable', 'Đã ghi nhận phê duyệt nhưng GitHub chưa gắn được nhãn ai-handle. Thử lại sau.');
        }
      }
    } else {
      const ok = await applyTriage(env.DB, id, input.action as TriageAction, {
        actor: learner.id, now,
        duplicateOf: input.action === 'mark_duplicate' ? input.duplicateOf : undefined,
        shippedRef: input.action === 'mark_shipped' ? input.shippedRef : undefined,
      });
      if (!ok) return apiError('conflict', 'Không thể chuyển đề xuất sang trạng thái này từ trạng thái hiện tại.');
    }
    const detail = await proposalDetail(env, id, now);
    return detail ? json(detail) : NOT_FOUND();
  } catch (err) {
    return toErrorResponse(err);
  }
};
