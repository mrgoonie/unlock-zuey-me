# Privacy and consent (ai-tutor)

Use the Vietnamese text below when you explain ai-tutor to the learner. Do not shorten away the "không gửi" list.

## Lời giải thích cho học viên

> **ai-tutor là gì?** Một bộ phân tích nền chạy trên máy chủ unlock.zuey.me (không phải một agent chạy trong Claude Code). Sau mỗi lượt trò chuyện kết thúc, hook trên máy bạn gửi một bản tóm lược đã che thông tin nhạy cảm; máy chủ viết báo cáo ngắn về cách bạn làm việc với AI, bạn xem ở trang **/insights**.
>
> **Được gửi:** câu hỏi gần nhất bạn gõ, câu trả lời cuối của Claude, tên các công cụ đã dùng (không kèm tham số hay kết quả), và nhiệm vụ AI Unlocked liên quan (nếu có).
>
> **Không bao giờ gửi:** suy luận ẩn của mô hình, nội dung file, thư mục làm việc, tham số và kết quả công cụ. Khoá API, token, mật khẩu, email, số điện thoại, số CCCD, số thẻ và đường dẫn thư mục nhà được che ngay trên máy bạn, rồi che thêm lần nữa trên máy chủ.
>
> **Cần bạn đồng ý hai lần:** (1) bật "Phân tích" trong Cài đặt trên web, (2) cho phép mình cài hook trên máy này. Thiếu một trong hai thì không có gì được lưu.
>
> **Bạn luôn kiểm soát:** tạm dừng (`pause`), xoá từng báo cáo hoặc toàn bộ dữ liệu trên web, thu hồi thiết bị, gỡ hook bất cứ lúc nào. Từ chối ai-tutor không ảnh hưởng tới việc học hay MCP.

## Consents (server side)

Three separate switches in Settings on the web, all off by default:

| Consent | Effect |
|---|---|
| `analysis` (Phân tích) | Required for any upload. Without it the server answers `403 consent_required` and stores nothing. Turning it off purges pending turns at once. |
| `share_operator` | The operator may read your detailed reports (also needs the observer consent). |
| `proposals` | Processed suggestions may feed product proposals. |

Operator dashboards otherwise show only anonymous counts over groups of at least 3 learners.

## What happens on this machine

- The hook reads nothing and sends nothing while paused, while unpaired, after the server refused the token, or during a server back-off (24 h after "consent off" or "feature off").
- Turns wait in `~/.config/ai-unlocked/spool/` (files 0600, at most 50 files, 1 MB, 24 h). `hook.log` records only time, HTTP status and duration.
- The device token lives in `~/.config/ai-unlocked/credentials.json` (0600). Only its SHA-256 is stored on the server; it expires after 90 days and can be revoked per device in Settings or with `uninstall --purge`.

## Retention

Reports are kept 90 days. Uploaded turns are deleted from the queue once processed (at most 7 days). Export and delete in Settings cover all insights data.
