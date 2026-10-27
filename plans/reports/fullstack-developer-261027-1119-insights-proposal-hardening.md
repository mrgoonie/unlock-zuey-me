# Báo cáo: gia cố đề xuất / GitHub cho insights (issue #37, phần A)

Trạng thái: hoàn thành. Nhánh `worktree-agent-aee24e6e015a2df2a`, commit `66458cd` (code, migration, test) và `3046222` (docs).

## Kết quả theo từng mục

1. **Sybil cohort (M5)**
   - (a) Bằng chứng chỉ được tính từ người học "established", xét tại thời điểm báo cáo được viết. Điều kiện: `l.kind = 'member'`, `r.created_at >= learners.created_at + 7 ngày`, và có ít nhất một `mission_runs` với `status = 'completed'` cùng `completed_at <= r.created_at`. Điều kiện này nằm trong `ESTABLISHED_LEARNER_SQL` của `proposal-store.ts`, được gộp vào `CONSENTED_EVIDENCE`, nên áp dụng cho cohort, đầu vào bản nháp, nội dung issue, kiểm tra draft cũ và danh sách operator.
   - Tôi chọn `mission_runs.status = 'completed'` vì đây là tín hiệu rõ nhất: chỉ một lần chấm đạt (`finalize-evaluation.ts`) mới đặt trạng thái này, và đây là trạng thái cuối, không đổi về sau. `xp_ledger` có nhiều lý do khác nhau, còn `evidence_submissions` chưa có nghĩa là đã đạt.
   - Báo cáo viết trước khi đủ điều kiện sẽ không bao giờ được tính, kể cả khi tài khoản đủ điều kiện về sau.
   - (b) Chỉ thao tác `file_issue` của operator mới tạo được issue, ở mọi chế độ. Cron không bao giờ tạo issue: `fileApproved` được thay bằng `recoverExpiredFilings`, chỉ xử lý các lease đã hết hạn. `fileProposal` với `operator: false` trả về `operator_required` khi hàng chưa ở trạng thái `filing`.
   - Logic ai-handle giữ nguyên: cần mode `issues_ai_handle`, cộng với tier `issue_ai_handle` của gate hoặc `approve_ai_handle` đã ghi nhận. UI giờ nói rõ trước khi bấm rằng issue có gắn ai-handle hay không, và copy của chế độ và toggle đã được sửa cho khớp.
2. **Trùng issue do GitHub search lag**
   - Migration `0010_insight_issue_filings.sql` chỉ thêm, không sửa gì cũ. Nó tạo bảng với `fingerprint` là PK, không có cột learner, và backfill các issue đã tạo cùng các hàng đang ở `filing`.
   - Trước khi tạo issue, code claim fingerprint bằng compare-and-set (`proposal-issue-ledger.ts`).
   - Issue đã ghi nhận được kiểm tra lại theo số issue.
   - Claim còn treo sau một lần tạo issue không rõ kết quả sẽ chặn mọi lần tạo tiếp theo. Nó chỉ được giải quyết qua `GET /repos/:repo/issues?labels=ai-insights&since=…` (hàm mới `listByFingerprintSince` trong publisher, không dùng search index). Nếu tìm thấy issue thì liên kết vào. Claim chỉ bị xoá khi danh sách đầy đủ chứng minh không có issue; nếu danh sách lỗi hoặc dài hơn 5 trang thì báo lỗi.
   - Nếu D1 lỗi sau khi đã tạo issue, claim vẫn được giữ.
3. **Hàng kẹt ở `filing` khi tắt GitHub**: khi không có publisher, `releaseExpiredFilings` trả các lease hết hạn về `accepted` hoặc `proposed` mà không gọi mạng. Claim fingerprint được giữ lại, nên khi bật GitHub lại thì issue cũ được liên kết thay vì tạo issue mới.
4. **Reset phê duyệt khi bản nháp bị thay bằng template**:
   - `replaceProposalDraft` xoá `ai_handle_approved_by`, chuyển `accepted` về `proposed` và xoá `decided_by`.
   - `fileProposal` không dùng phê duyệt cũ nếu bản nháp vừa bị thay ngay trong lúc tạo issue.
   - `accept` và `approve_ai_handle` gọi `syncProposalDraft` trước, nên quyết định gắn với bản nháp đã lưu và không bị huỷ nhầm về sau.
5. **Ẩn đề xuất dưới cohort**: `VISIBLE_PROPOSAL_SQL` ẩn các đề xuất chưa có issue khi cohort đã đồng ý (mọi thời điểm, người học established) dưới 3. Quy tắc này áp dụng cho list, detail (`404`) và PATCH (`404`). Đề xuất hiện lại khi cohort về lại ≥ 3. Tôi không sửa `operator-insight-queries.ts`.

## File

- Thêm mới:
  - `migrations/0010_insight_issue_filings.sql`
  - `src/lib/insights/proposal-issue-ledger.ts`
  - `tests/unit/insights-proposal-github-filing.test.ts` (các test GitHub tách ra từ stage test)
  - `tests/unit/insights-proposal-issue-ledger.test.ts`
- Sửa:
  - `proposal-store.ts`, `proposal-filing.ts`, `proposal-assessment.ts`, `proposal-stage.ts`, `github-issue-publisher.ts`
  - `src/pages/api/v1/admin/insights/proposals/[id].ts`
  - `OperatorAutomationSettings.tsx`, `ProposalDetail.tsx`
  - Các test: `insights-proposal-stage*.ts`, `insights-proposal-consent-withdrawal.test.ts`, `insights-github-publisher.test.ts`
  - Docs: `docs/insights-ingest-contract.md`, `docs/insights-rollout.md`, `docs/api-contract.md`
- **Ngoài danh sách sở hữu (sửa tối thiểu, bắt buộc để test xanh):**
  - `tests/unit/insights-migration-schema.test.ts`: thêm `insight_issue_filings` vào danh sách bảng. Agent làm migration 0009 có thể cũng sửa dòng này, nên dễ xung đột khi merge.
  - `tests/unit/insights-end-to-end-pipeline.test.ts`: `seedMember` giờ tạo người học established (tài khoản 30 ngày, có một mission đã hoàn thành).

## Kiểm tra

- `bunx vitest run`: 84 file, 939 test đều qua.
  - Lần chạy đầu có 3 test hiệu năng fail vì máy đang tải nặng (redaction, push reminder, stop hook p95). Baseline trước khi tôi sửa cũng fail các test này, và lần chạy sau thì qua.
- `bunx tsc --noEmit`: sạch, sau khi `astro check` sinh lại type.
- `bun run build`: qua.
- `bun run migrations:check`: OK.

## Câu hỏi còn mở

- Khi `safe_auto_implement` bật, tier `issue_ai_handle` của gate vẫn tự gắn ai-handle lúc operator bấm tạo issue, không cần `approve_ai_handle` riêng. Tôi hiểu "keep the existing ai_handle approval on top" là giữ nguyên logic hiện tại. Nếu chủ dự án muốn ai-handle luôn cần `ai_handle_approved_by` thì chỉ cần sửa một dòng trong `fileProposal`.
- `productSignals` trong `operator-insight-queries.ts` (dashboard tổng quan) vẫn đếm người học có consent mà chưa established, và vẫn hiện tiêu đề signal khi đủ 3 người như vậy. Tôi không sửa vì đó là phạm vi của agent khác.
- Tuổi tài khoản tính từ `learners.created_at`. Guest được nâng lên member giữ ngày tạo ban đầu, nên một guest đã chờ đủ 7 ngày rồi mới đăng nhập vẫn được tính. Chi phí cho kẻ tấn công vẫn là 7 ngày chờ cộng một mission đã đạt.
- Issue tạo tay từ "Sao chép nội dung issue" mà không có nhãn `ai-insights` thì chỉ tìm được qua search (vẫn có độ trễ). Đây là đường thủ công nên tôi chấp nhận.
