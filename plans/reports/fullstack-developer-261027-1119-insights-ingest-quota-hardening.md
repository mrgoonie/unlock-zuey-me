# Báo cáo triển khai: issue #37 phần B (chống lạm dụng và chi phí cho insights)

- Ngày: 2026-10-27 · Nhánh: `worktree-agent-a888e455c18fe6c41` · Trạng thái: hoàn thành (còn một lưu ý về test đo thời gian)
- Commit: `908108c`, `e91c6f2`, `067da11`, `1f072cc` (chưa push, chưa mở PR, không đụng production)

## Kết quả theo từng mục

1. **Xoá báo cáo không còn trả lại hạn mức phân tích trong ngày.** `insights-quotas.ts` giờ đếm từ các dòng `insight_events` đã xử lý: `done` (đếm `DISTINCT report_id`) và `skipped/not_learning` (theo phiên và `processed_at`). Người học không xoá được các dòng này: `deleteAllReports` và việc tắt đồng ý chỉ xoá dòng `pending` hoặc `processing`. Các dòng được giữ 7 ngày, lâu hơn ngày UTC mà chúng được tính. Hạn mức theo người học, theo phiên và toàn cục đều dùng chung một nguồn. Không cần migration, nên 0009 chưa được dùng.
2. **Giới hạn 10 token đang hoạt động cho mỗi người học.** `createToken` chạy một batch: INSERT token mới, rồi đặt `revoked_at = now` cho các token cũ nhất vượt quá `MAX_ACTIVE_TOKENS_PER_LEARNER` (cách ghi giống thao tác thu hồi trong Settings). Lệnh UPDATE không làm gì nếu INSERT không ghi được dòng nào. `listTokens` bỏ `LIMIT 50`. Settings có thêm dòng "Tối đa 10 thiết bị…", và có test giữ câu này khớp với hằng số.
3. **Lease của các cửa sổ phân tích muộn trong cùng một lần cron.** `claimClock(budget, now)` cộng thêm vào `now` thời gian thực đã trôi qua, lấy từ đồng hồ của cron budget. Nhờ vậy mỗi cửa sổ có đủ 5 phút lease tính từ lúc nó được claim. Trước đây lease hết hạn ở mốc `tickStart + 5 phút`, trong khi budget cho phép chạy tới 8 phút.
4. **Truy vấn tín hiệu cho operator.** `productSignals` giờ thêm điều kiện `c.proposals_at IS NOT NULL AND r.created_at >= c.proposals_at`, giống `CONSENTED_EVIDENCE` bên phía đề xuất.
5. **Thời gian chờ sau `consent_required` giảm từ 24 giờ xuống 1 giờ.** Thêm `CONSENT_BLOCK_MS` vào `constants.mjs`. Lỗi `feature_off` vẫn chờ 24 giờ. Skill được nâng lên `0.1.1` ở `manifest.json` và `SKILL_VERSION`. Mã sha256 do `skill-bundle.ts` tính lúc build nên không có file nào cần tạo lại. Tài liệu tham khảo của skill và bảng trong contract đã được cập nhật.
6. **`pair/start` chỉ còn 1 lần ghi KV.** Device code có dạng: user code (8 ký tự, không có gạch nối) cộng 35 ký tự base64url ngẫu nhiên (210 bit). Vẫn là 43 ký tự nên khớp `PAIR_DEVICE_CODE_PATTERN`, và hợp đồng poll/confirm không đổi. Mỗi lần ghép nối chỉ còn một bản ghi KV `insights:pair:user:<code>`, chứa `deviceHash`. Một lần poll có mã sai bí mật trả về `expired` mà không ghi hay xoá gì.
7. **Xoá một phần lượt trong lúc gọi model.** `completeWindow` giờ so `COUNT(*)` của các id còn lại với `ids.length`. Thiếu dù chỉ một dòng thì kết quả là `revoked`.

## Các file đã sửa

- Mã nguồn:
  - `src/lib/insights/insights-quotas.ts`
  - `src/lib/insights/analyzer-stage.ts`
  - `src/lib/insights/event-queue.ts`
  - `src/lib/insights/ingest-tokens.ts`
  - `src/lib/insights/ingest-contract.ts`
  - `src/lib/insights/device-pairing.ts`
  - `src/lib/insights/operator-insight-queries.ts` (chỉ sửa `productSignals`)
  - `src/components/settings/InsightsSettingsPanel.tsx`
- Skill:
  - `skills/ai-unlocked/manifest.json`
  - `skills/ai-unlocked/scripts/lib/{constants,flush-runner,local-state}.mjs`
  - `skills/ai-unlocked/references/{troubleshooting,privacy-and-consent}.md`
- Tài liệu: `docs/insights-ingest-contract.md`
- Test:
  - mới: `tests/unit/insights-ingest-token-cap.test.ts`
  - sửa:
    - `insights-analyzer-stage`
    - `insights-ai-budget`
    - `insights-event-queue`
    - `insights-ingest-device-pairing`
    - `insights-operator-access-aggregates`
    - `skill-spool-flush`

Không sửa file proposal-*, publisher, issue-draft, fingerprint, operator-settings, các trang admin proposal hay mã runner.

## Kiểm tra

- `bunx tsc --noEmit`: sạch, sau khi `astro build` đã tạo kiểu `astro:*`. Trên một worktree mới, trước lần build đầu tiên, chỉ có lỗi môi trường ở `import.meta.glob` và `astro:middleware`, nằm ở những file không bị sửa.
- `bun run build`: astro check báo 0 lỗi, build thành công.
- `bun run migrations:check`: OK.
- `bunx vitest run`: 926/931 qua. 5 test lỗi đều là test đo thời gian:
  - redaction perf và push-reminder: chạy riêng lẻ đều qua (78/78 và 18/18).
  - `skill-stop-hook-overhead` (p95 < 250 ms): vẫn lỗi cả khi chạy riêng. Load average của máy đang ở mức 56–80, và riêng `node -e ""` đã mất 110–560 ms. Thay đổi lần này không chạm vào đường chạy của hook, chỉ đổi hằng số thời gian chờ và nhánh xử lý 403 trong uploader. Cần chạy lại khi máy rảnh.
- Các test mới được viết để bắt đúng hành vi cũ. Tôi suy ra từ code là chúng sẽ thất bại trên code cũ, nhưng chưa chạy thử trên code cũ:
  - quota sau `deleteAllReports`;
  - lease ở các mốc +5, +9, +13 phút;
  - xoá một phần lượt thì ra `revoked`;
  - `pair/start` ghi KV đúng 1 lần, và mã giả bị từ chối mà không ghi KV;
  - giới hạn 10 token, kể cả với dữ liệu cũ đã vượt giới hạn;
  - bằng chứng có trước khi đồng ý không được tính;
  - thời gian chờ 1 giờ, rồi tự gửi lại.

## Lưu ý

- Những lần ghép nối đang dở lúc deploy (bản ghi `dev:` kiểu cũ, sống tối đa 10 phút) sẽ nhận `expired` và phải chạy lại `ai-unlocked pair`. Tôi không viết nhánh tương thích, vì nó chỉ có tác dụng trong 10 phút.
- Người học đang có hơn 10 token chỉ được đưa về 10 ở lần ghép nối kế tiếp. Không có migration nào sửa dữ liệu cũ, đúng quy tắc chỉ thêm.
- Bản báo cáo này để trong worktree và chưa commit.

## Câu hỏi còn mở

- Có nên chạy lại `skill-stop-hook-overhead` trong CI hoặc khi máy rảnh trước khi merge không?
