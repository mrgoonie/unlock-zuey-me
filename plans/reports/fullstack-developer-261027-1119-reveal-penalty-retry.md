# Báo cáo: giữ phạt xem đáp án / gợi ý khi bỏ lượt rồi làm lại (issue #37, phần C)

## Kết quả
Đã xong. Bỏ lượt ("Bỏ lượt này") không còn xoá được phạt xem đáp án và phạt dùng gợi ý. Phạt giờ gắn với người học + mission (trong một "lần thử": mọi lượt bị bỏ kể từ lần hoàn thành mission gần nhất), không gắn với từng lượt. Không cần migration.

## Phạt hiện có và cách giữ lại
- **Xem đáp án**: phạt thực sự là khoá câu trả lời đã xem (`assertRevealedUnchanged`). Lượt mới (`startMissionImpl`) giờ bắt đầu với các reveal của lượt đã bỏ đã ghi sẵn, và câu trả lời ban đầu được điền sẵn và khoá lại. Vì vậy khi chấm, hệ thống thấy đúng câu trả lời người học đưa ra trước khi xem đáp án. Kết quả giống hệt như khi không bỏ lượt.
- **Gợi ý**: phạt là mất thưởng "không dùng gợi ý" (+20% XP) và huy hiệu `solo-pass`. `finalizeEvaluation` cộng `hints_used` của các lượt đã bỏ trong lần thử hiện tại vào số gợi ý của lượt được chấm. `hints_used` của từng lượt giữ nguyên, nên số liệu admin (HintDependence) vẫn đúng.
- Sau khi đã hoàn thành mission, "Làm lại" mở một lần thử mới và không mang phạt nào theo. Lý do: XP chỉ trả một lần cho mỗi mission, và lượt đã hoàn thành vốn đã hiện toàn bộ đáp án.
- Một reveal cũ bị bỏ qua nếu nội dung hiện tại không còn khoá được nó: bước không còn, mục không reveal được, hoặc phương án không còn hợp lệ.

## File đã sửa
- `src/lib/learning/carried-penalties.ts` (mới, 80 dòng): có `carriedReveals` và `carriedHintsUsed`.
- `src/lib/learning/mission-runs.ts`: seed reveal + câu trả lời khoá khi tạo lượt mới.
- `src/lib/learning/finalize-evaluation.ts`: XP/huy hiệu dùng tổng gợi ý của cả lần thử.
- `src/lib/learning/answer-reveals.ts`: export `revealableEntry`, `lockedFields`, `isAnswered`; cập nhật comment.
- `src/lib/learning/abandon-run.ts`, `src/lib/learning/service.ts`: chỉ sửa comment.
- `src/components/mission/AbandonRunControl.tsx`: lời nhắc trung thực hơn. Câu đã xem đáp án giữ câu trả lời cũ và không sửa được; gợi ý đã xem vẫn tính nên mất thưởng "không dùng gợi ý".
- `src/lib/mcp/tools/run-tools.ts`: mô tả tool `abandon_mission` nói rõ phạt được giữ.
- `docs/api-contract.md`: dòng `POST /runs/:id/abandon`.
- `tests/unit/learning-abandon-keeps-penalties.test.ts` (mới, 5 test).

## Kiểm thử
- Test mới: reveal → bỏ lượt → làm lại có câu trả lời khoá, đáp án hiện lại, autosave/MCP submit sửa câu khoá bị 403, chấm deterministic thấy câu sai cũ. Phạt mang qua nhiều lần bỏ; không lẫn sang người học khác hay mission khác; bỏ qua reveal không còn hợp lệ. Có gợi ý → bỏ → làm lại → đạt: 180 XP thay vì 210, không có `solo-pass`. "Làm lại" sau khi hoàn thành không mang phạt.
- `bunx vitest run`: 921/924 pass ở lần chạy đầu. 3 test thời gian bị lỗi khi máy tải nặng (redaction perf, push-reminder, skill-stop-hook-overhead); chạy riêng thì pass cả 97/97.
- `bun run build` (astro check + build): 0 lỗi, 0 cảnh báo.
- `bunx tsc --noEmit`: 10 lỗi, tất cả nằm ở file không đụng tới (`import.meta.glob`, `astro:middleware` thiếu kiểu khi chạy tsc thuần). Không có lỗi nào trong file đã sửa. `astro check` là bước kiểm tra kiểu thực sự và đã sạch.

## Ghi chú
- Không đụng `src/lib/insights`, `src/pages/api/ingest`, `skills/**`, trang admin insights hay migrations.
- Không push, không mở PR.

## Câu hỏi còn mở
- Có nên báo cho người học ngay trong runner, ở lượt mới (không chỉ trong hộp thoại bỏ lượt), rằng một số câu đã khoá từ lượt trước? Hiện UI hiển thị các câu đó như câu đã xem đáp án bình thường.
