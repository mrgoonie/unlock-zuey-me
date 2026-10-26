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
| `POST /api/v1/push/subscribe` | `{ subscription, remindTime: "HH:MM", timezone }` → `{ status }`. Endpoint must be a known push service (FCM, Mozilla, Apple, WNS) |
| `POST /api/v1/push/unsubscribe` | `{ endpoint }` → `{ status }` (idempotent) |
| `GET /api/v1/push/settings` | `{ status: { devices, enabled, remindTime, timezone, lastSentDay } }` |
| `PATCH /api/v1/push/settings` | `{ remindTime?, enabled? }` → `{ status }` (all of the learner's devices; 404 if none) |
| `GET /api/v1/push/public-key` | `{ key }` (VAPID public key; 503 when not configured) |
| `POST /api/v1/push/opened` | `{ tag?, url? }` sent by `public/sw.js` on notification click → `push.opened` event |
| `PATCH /api/v1/me/consent` | `{ observer: boolean }` → `{ observerConsent }` (emits `consent.granted` / `consent.revoked` on change) |
| `GET /api/v1/me/export` | JSON download of all the learner's data (credentials such as token hashes and push keys omitted) |
| `POST /api/v1/me/delete` | `{ confirm: "XOA" }` deletes the learner's rows (incl. merged guests) and R2 `ev/<learnerId>/*`, expires cookies; idempotent |
| `GET /api/v1/admin/learners` | admin only; learners with consent |
| `GET /api/v1/admin/learners/:id` | admin only; timeline (first page), funnel, hints, scores, calibration, competencies, first win, evidence, coach chats (consent required, checked per request) |
| `GET /api/v1/admin/learners/:id/events?cursor=&limit=` | admin only; older timeline pages `{ events, nextCursor }` |

Non-admins get `404 not_found` from every admin route and page (never 403). A learner without `observer_consent = 1` is `not_found` for admins too. Evidence images on `/admin` load from `GET /api/v1/evidence/<key>` with each `/`-separated key segment URL-encoded.

Push reminder cron (`src/lib/push/reminder-job.ts`): every 15 minutes, sends at most one reminder per subscription per local day when `remind_time` is in the current local quarter hour and the learner has no `activity_days` row for that day. A 404/410 from the push service deletes the subscription; 5 consecutive failures disable it.
