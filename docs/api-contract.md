# API contract (v1)

Shared contract between the learner UI, the learning engine, identity, MCP and observer modules. Types live in `src/lib/learning/types.ts`. Helpers: `src/lib/http/api-response.ts` (JSON + error shape), `src/lib/db/ids.ts`, `src/lib/observer/events.ts`.

## Conventions

- JSON in and out. Errors are `{ "error": { "code", "message" } }`. Codes: `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `invalid` 400, `rate_limited` / `budget_exceeded` 429, `unavailable` 503, `internal` 500.
- Learner identity comes from `Astro.locals.learner` (`LearnerContext`). The middleware (identity module) guarantees it is set for `/api/v1/**` and every learner page by creating a guest learner + cookie session on first visit. It is **not** created for `/`, `/api/health`, `/certificates/*`, `/oauth/*`, `/mcp`, static assets.
- State-changing requests (`POST/PATCH/PUT/DELETE` under `/api/v1`) must be same-origin; the middleware rejects a foreign `Origin` with 403.
- Every query is scoped to `locals.learner.id`. Accessing another learner's run returns `not_found` (never leak existence).
- Messages shown to learners are Vietnamese.

## Learning engine (owner: engine module)

| Method & path | Body | Response |
|---|---|---|
| `GET /api/v1/me` | – | `{ learner: LearnerContext, progress: ProgressSummary }` |
| `PATCH /api/v1/me/profile` | `{ profile?: Partial<LearnerProfile>, displayName?: string }` | `{ learner }` |
| `GET /api/v1/missions` | – | `{ missions: MissionListItem[] }` |
| `POST /api/v1/missions/:id/start` | `{}` | `{ run: MissionRun }` (resumes the open run if any) |
| `GET /api/v1/runs/:id` | – | `{ run, mission: Mission, evaluation: Evaluation \| null }` |
| `PATCH /api/v1/runs/:id/answers` | `{ stepId, answers, currentStep?, rev }` | `{ run }`; `409 conflict` with `{ error, run }` when `rev` is stale |
| `POST /api/v1/runs/:id/hints` | `{ stepId, level: 1..4 }` | `HintResult` |
| `POST /api/v1/runs/:id/submit` | `{ idempotencyKey, confidence?: 0..100, imageKeys?: string[] }` | `SubmitResult` |
| `POST /api/v1/evidence/upload` | multipart `file` (image ≤ 5 MB) | `{ key }` |
| `GET /api/v1/evidence/:key` | – | image bytes (owner, or admin observer with consent) |
| `POST /api/v1/coach/chat` | `{ runId?, stepId?, messages: [{role, content}] }` | `{ reply, model, remainingToday }` |
| `POST /api/v1/labs/:id/result` | `{ result: object }` | `{ labsDone: string[], newBadges }` (labs never grant XP) |
| `POST /api/v1/concepts/:id/view` | – | `{ ok: true }` |
| `GET /api/v1/recap?period=week` | – | `{ period, missionsCompleted, xpGained, competencyDeltas, highlights: string[], reflections: string[] }` |
| `POST /api/v1/certificates` | `{ displayName }` | `{ code, url }` (`403 forbidden` if not eligible) |
| `POST /api/v1/events` | `{ name, missionId?, runId?, props? }` (allow-listed client events only) | `{ ok: true }` |

Rewards rules: XP only from a **passed** evaluation (once per run, via `xp_ledger` uniqueness). Badges from `content/badges.yaml`. Soft streak counts active days and tolerates 1 rest day per 7.

## Identity (owner: identity module)

| Path | Purpose |
|---|---|
| `GET /auth/zuey/login?return_to=` | Starts Sign in with zuey.me (PKCE, CIMD client `https://unlock.zuey.me/oauth/zuey-client.json`, scopes `openid profile email`) |
| `GET /auth/zuey/callback` | Exchanges code, calls zuey.me `/oauth/userinfo`, upserts member, merges current guest progress, rotates session |
| `POST /auth/logout` | Ends the session (a new guest is created on next visit) |
| `GET /oauth/zuey-client.json` | CIMD client metadata document |

## MCP (owner: MCP module)

`/mcp` Streamable HTTP behind `@cloudflare/workers-oauth-provider` (`/authorize`, `/oauth/token`, `/oauth/register`, PRM at `/.well-known/oauth-protected-resource/mcp`). Tools call `src/lib/learning/service.ts` with the learner bound to the token: `get_profile`, `list_missions`, `get_mission`, `start_mission`, `get_run`, `submit_evidence`, `get_hint`.

## PWA, push, observer, data rights (owner: platform module)

| Method & path | Purpose |
|---|---|
| `POST /api/v1/push/subscribe` | `{ subscription, remindTime: "HH:MM", timezone }` |
| `POST /api/v1/push/unsubscribe` | `{ endpoint }` |
| `PATCH /api/v1/push/settings` | `{ remindTime?, enabled? }` |
| `GET /api/v1/push/public-key` | `{ key }` (VAPID public key) |
| `PATCH /api/v1/me/consent` | `{ observer: boolean }` |
| `GET /api/v1/me/export` | JSON download of all the learner's data |
| `POST /api/v1/me/delete` | `{ confirm: "XOA" }` deletes the learner's data and ends the session |
| `GET /api/v1/admin/learners` | admin only; learners with consent |
| `GET /api/v1/admin/learners/:id` | admin only; timeline, funnel, hints, scores, evidence (consent required, checked per request) |
