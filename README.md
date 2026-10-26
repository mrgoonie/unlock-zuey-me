# AI Unlocked · unlock.zuey.me

Webapp mobile-first tiếng Việt giúp người mới **tự làm việc thật với AI và biết kiểm chứng**. Mỗi mission là một việc trong đời sống. Người học làm cùng AI, nộp bằng chứng, được chấm theo rubric và nhận XP/huy hiệu khi bằng chứng đạt.

- Production: https://unlock.zuey.me (Cloudflare Workers, deploy bằng GitHub Actions từ `main`)
- Đăng nhập: chế độ khách hoặc **Sign in with zuey.me** (OAuth 2.1 + PKCE, tiến độ khách được gộp vào tài khoản)
- `/mcp`: MCP server (Streamable HTTP + OAuth) dùng chung learning engine với web
- `/skill`: skill `ai-unlocked` cho Claude Code và báo cáo ai-tutor (tuỳ chọn, chỉ khi bật `INSIGHTS_MODE`, xem bên dưới)

## Stack

Astro 5 (SSR) + React islands + Tailwind 3 · Cloudflare Workers + D1 + KV + R2 + Workers AI · OpenRouter (coach/grader) · zod + YAML content · Vitest + Playwright · bun.

## Cấu trúc

| Đường dẫn | Vai trò |
|---|---|
| `content/` | Mission, khái niệm, huy hiệu (YAML). Schema ở `src/lib/content/schema.ts` |
| `src/lib/learning/` | Learning engine: run, chấm điểm, XP, huy hiệu, streak. Web và MCP chỉ gọi `service.ts` |
| `src/lib/coach/` | Gợi ý 4 nấc, chat luyện tập, grader AI (OpenRouter → fallback Workers AI, hạn mức chi phí) |
| `src/lib/identity/` | Session khách/thành viên, Sign in with zuey.me |
| `src/lib/mcp/` | `/mcp` OAuth provider + tools |
| `src/lib/push/` | Web Push nhắc nhở (cron 15 phút) |
| `src/lib/observer/` | Dashboard quan sát (chỉ khi người học đồng ý) |
| `src/lib/insights/` | ai-tutor insights: nhận lượt làm việc từ thiết bị, đồng ý, ghép nối thiết bị, bộ phân tích nền ai-tutor, đề xuất và cổng tạo issue GitHub (mặc định tắt) |
| `skills/ai-unlocked/` | Skill Claude Code `ai-unlocked` + Stop hook (che thông tin bí mật, không bao giờ chặn), phục vụ tại `/skill` |
| `src/worker.ts` | Worker entry: Astro fetch + `scheduled` |
| `migrations/` | D1 schema |

## Phát triển

```bash
bun install
bun run db:migrate:local
bun run dev            # http://localhost:4321
bun run content:check  # kiểm schema nội dung
bun run test           # unit
bun run e2e            # Playwright, mặc định nhắm production (E2E_BASE_URL để đổi)
bun run build          # astro check + build
bun run preview        # wrangler dev với bản build
```

Secrets (không commit): `OPENROUTER_API_KEY`, `SESSION_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`; tuỳ chọn `GITHUB_ISSUES_TOKEN` (fine-grained PAT, chỉ quyền Issues: write trên repo, chỉ đặt khi bật tạo issue). Local: `.dev.vars`. Production: `wrangler secret put` (CI đồng bộ `OPENROUTER_API_KEY` từ GitHub secrets).

## ai-tutor insights (mặc định tắt)

Người học là thành viên zuey.me có thể tự chọn cài skill `ai-unlocked` vào Claude Code từ [`/skill`](https://unlock.zuey.me/skill). Stop hook che thông tin bí mật rồi gửi từng lượt làm việc vào hàng đợi; bộ phân tích nền ai-tutor trên máy chủ viết báo cáo học tập ngắn ở `/insights`. Mọi thứ chỉ chạy khi người học đồng ý, và có thể tạm dừng, xoá hoặc thu hồi bất cứ lúc nào.

Vars trong `wrangler.jsonc`: `INSIGHTS_MODE` (`off` mặc định · `internal` · `pilot` · `on`), `INSIGHTS_PILOT_EMAILS`, `INSIGHTS_RETENTION_DAYS` (90), `INSIGHTS_DAILY_ANALYSES_PER_LEARNER` (12), `INSIGHTS_DAILY_ANALYSES_GLOBAL` (200), `INSIGHTS_GITHUB_ISSUES` (`off` mặc định · `issues` · `issues_ai_handle`, luôn tắt khi thiếu `GITHUB_ISSUES_TOKEN`), `INSIGHTS_GITHUB_REPO`. Khi `INSIGHTS_MODE=off`, mọi trang, API và file `/skill` trả 404 và cron không làm gì.

Tài liệu: [hợp đồng ingest và quyền riêng tư](docs/insights-ingest-contract.md), [API](docs/api-contract.md#ai-tutor-insights-owner-insights-module-issue-25), [kế hoạch bật dần, rollback và QA thủ công](docs/insights-rollout.md).

## Đóng góp

`main` được bảo vệ bằng quy ước: mọi thay đổi qua PR, CI (`content:check`, `migrations:check`, `test`, `build`) phải xanh. Merge vào `main` sẽ tự deploy. Thứ tự deploy, quy tắc migration tương thích ngược và cách rollback: [docs/deployment.md](docs/deployment.md).
