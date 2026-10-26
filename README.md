# AI Unlocked · unlock.zuey.me

Webapp mobile-first tiếng Việt giúp người mới **tự làm việc thật với AI và biết kiểm chứng**. Mỗi mission là một việc trong đời sống. Người học làm cùng AI, nộp bằng chứng, được chấm theo rubric và nhận XP/huy hiệu khi bằng chứng đạt.

- Production: https://unlock.zuey.me (Cloudflare Workers, deploy bằng GitHub Actions từ `main`)
- Đăng nhập: chế độ khách hoặc **Sign in with zuey.me** (OAuth 2.1 + PKCE, tiến độ khách được gộp vào tài khoản)
- `/mcp`: MCP server (Streamable HTTP + OAuth) dùng chung learning engine với web

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
| `src/worker.ts` | Worker entry: Astro fetch + `scheduled` |
| `migrations/` | D1 schema |

## Phát triển

```bash
bun install
bun run db:migrate:local
bun run dev            # http://localhost:4321
bun run content:check  # kiểm schema nội dung
bun run test           # unit
bun run build          # astro check + build
bun run preview        # wrangler dev với bản build
```

Secrets (không commit): `OPENROUTER_API_KEY`, `SESSION_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`. Local: `.dev.vars`. Production: `wrangler secret put` (CI đồng bộ `OPENROUTER_API_KEY` từ GitHub secrets).

## Đóng góp

`main` được bảo vệ bằng quy ước: mọi thay đổi qua PR, CI (`content:check`, `migrations:check`, `test`, `build`) phải xanh. Merge vào `main` sẽ tự deploy. Thứ tự deploy, quy tắc migration tương thích ngược và cách rollback: [docs/deployment.md](docs/deployment.md).
