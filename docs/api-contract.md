# API contract (v1)

Shared contract between the learner UI, the learning engine, identity, MCP and observer modules. Types live in `src/lib/learning/types.ts`. Helpers: `src/lib/http/api-response.ts` (JSON + error shape), `src/lib/db/ids.ts`, `src/lib/observer/events.ts`.

## Conventions

- JSON in and out. Errors are `{ "error": { "code", "message" } }`. Codes: `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `invalid` 400, `rate_limited` / `budget_exceeded` 429, `unavailable` 503, `internal` 500.
- Throttles (`src/lib/identity/request-rate-limits.ts`, Workers Rate Limiting bindings in `wrangler.jsonc`): new guests per IP; `coach/chat`, `runs/:id/hints`, `runs/:id/submit`, `evidence/upload` per IP; `events`, `labs/:id/result`, `missions/:id/start`, `push/subscribe` per IP and per learner. Over the limit → `rate_limited` 429. AI budgets (per learner and global USD for OpenRouter, per learner and global daily request caps for Workers AI) live in `src/lib/coach/ai-usage.ts`.
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
| `POST /api/v1/missions/:id/start` | `{ again?: boolean }` (body optional) | `{ run: MissionRun }`: the open run, else the latest completed run (result, read-only), else a new run. `again: true` starts a new run of a completed mission ("Làm lại") |
| `GET /api/v1/runs/:id` | – | `{ run, mission: LearnerMission, evaluation: Evaluation \| null, answerKey: AnswerKey }` |
| `PATCH /api/v1/runs/:id/answers` | `{ stepId, answers, currentStep?, rev }` | `{ run }`; `409 conflict` with `{ error, run }` when `rev` is stale |
| `POST /api/v1/runs/:id/hints` | `{ stepId, level: 1..4 }` | `HintResult` |
| `POST /api/v1/runs/:id/reveal` | `{ stepId, itemId }` (quiz question id, or `prediction`) | `{ run, key: AnswerKeyEntry }`; the answer must be saved first and is locked afterwards (`403 forbidden` on change) |
| `POST /api/v1/runs/:id/submit` | `{ idempotencyKey, confidence?: 0..100, imageKeys?: string[] }` | `SubmitResult & { answerKey }` |
| `POST /api/v1/evidence/upload` | multipart `file` (image ≤ 5 MB) | `{ key }` |
| `GET /api/v1/evidence/:key` | – | image bytes (owner, or admin observer with consent) |
| `POST /api/v1/coach/chat` | `{ runId?, stepId?, messages: [{role, content}] }` (1–20 messages; `assistant` turns are kept only if they match a reply the server stored for this learner in the last 24 h) | `{ reply, model, remainingToday }` |
| `POST /api/v1/labs/:id/result` | `{ result: object }` | `{ labsDone: string[], newBadges }` (labs never grant XP) |
| `POST /api/v1/concepts/:id/view` | – | `{ ok: true }` |
| `GET /api/v1/recap?period=week` | – | `{ period, missionsCompleted, xpGained, competencyDeltas, highlights: string[], reflections: string[] }` |
| `POST /api/v1/certificates` | `{ displayName }` | `{ code, url }` (`403 forbidden` if not eligible) |
| `POST /api/v1/events` | `{ name, missionId?, runId?, props? }` (allow-listed client events only) | `{ ok: true }` |

Answer keys: the browser only gets `LearnerMission` (`src/lib/learning/learner-mission-view.ts`), which has no claim verdicts, quiz/prediction answers, explanations, static hints or rubric checks. `answerKey` (`"stepId:itemId"` → `{ correct, explanation }`) holds only items revealed on the server, or every item once the run is `completed`.

Runs: at most one open run per learner and mission (partial unique index). Evidence image keys stay readable and re-submittable by the member a guest uploader was merged into; admin reads follow that member's consent.

Rewards rules: XP only from a **passed** evaluation, once per learner per mission (`xp_ledger` ref = mission id; later passing runs earn 0 XP). Badges from `content/badges.yaml`. Soft streak counts active days and tolerates 1 rest day per 7.

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
| `GET /api/v1/me/export` | JSON download of all the learner's data (credentials such as token hashes and push keys omitted). Bounded per table and in total; tables cut off are listed in `continuation` with a `?table=<name>&after=<n>` URL returning the next page (`{ rows, next }`) |
| `POST /api/v1/me/delete` | `{ confirm: "XOA" }` deletes the learner's rows (incl. merged guests) and R2 `ev/<learnerId>/*`, expires cookies; idempotent |
| `GET /api/v1/admin/learners` | admin only; learners with consent |
| `GET /api/v1/admin/learners/:id` | admin only; timeline (first page), funnel, hints, scores, calibration, competencies, first win, evidence, coach chats (consent required, checked per request) |
| `GET /api/v1/admin/learners/:id/events?cursor=&limit=` | admin only; older timeline pages `{ events, nextCursor }` |

Non-admins get `404 not_found` from every admin route and page (never 403). A learner without `observer_consent = 1` is `not_found` for admins too. Evidence images on `/admin` load from `GET /api/v1/evidence/<key>` with each `/`-separated key segment URL-encoded.

Push reminder cron (`src/lib/push/reminder-job.ts`): every 15 minutes, sends at most one reminder per subscription per local day when `remind_time` is in the current local quarter hour (or up to 60 minutes earlier that day, to catch up a run that hit its budget) and the learner has no `activity_days` row for that day. Due subscriptions are processed in batches until done, within a per-run time and send budget. A learner keeps at most 5 subscriptions (the least recently subscribed is replaced).

Cleanup cron (`src/lib/jobs/`): guests with no runs inactive for 7 days, and guests with no progress inactive for 30 days, are erased; evidence images older than 24 h that no submission references (and whose owner has no recently touched open run) are deleted from R2. A 404/410 from the push service deletes the subscription; 5 consecutive failures disable it.
