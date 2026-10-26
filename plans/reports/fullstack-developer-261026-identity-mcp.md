# Module D: identity, Sign in with zuey.me, OAuth-protected /mcp

Branch `feat/identity-mcp`, part of #1. Status: complete. All gates are green, with two follow-ups owned by other modules (listed below).

## What shipped

### Guest sessions (`src/lib/identity/session-store.ts`, `request-learner.ts`, `src/middleware.ts`)

- The `uz_session` cookie is HttpOnly, Secure, SameSite=Lax, Path=/ and lasts 180 days. The expiry slides at most once a day.
- The cookie holds a 32-byte random token. D1 stores only its SHA-256 hash.
- A guest learner and its session are created lazily, in one batch, only when `learnerPolicy` returns `create`.
- These requests never create a guest:
  - `/` and `/certificates/*`
  - `/authorize` and the `/auth/*` routes, except `/auth/zuey/login`, which binds the login to the browser
  - `/mcp`, `/oauth/*`, `/.well-known/*`, `/_astro/*`, `/api/health` and static assets
  - bots, including requests with an empty User-Agent
- A malformed or unknown cookie is cleared.
- A session whose learner was merged or deleted no longer resolves.
- State-changing `/api/v1` requests from a foreign `Origin`, or with `Sec-Fetch-Site: cross-site` or `same-site`, get a 403 before any database work.
- `/api/v1` requests that end up without a learner (bots) get a 401.
- `isAdmin` is true only for a member whose verified email is in `ADMIN_EMAILS`.
- Security headers:
  - Every response gets nosniff and Referrer-Policy.
  - HTML responses also get the CSP, `X-Frame-Options: DENY` and Permissions-Policy. The CSP is off in `astro dev`.

### Sign in with zuey.me (`src/lib/identity/*`, `src/pages/auth/**`, `src/pages/oauth/zuey-client.json.ts`)

**Login (`/auth/zuey/login`)**
- Creates a `login_requests` row with a 32-byte state, a PKCE verifier and the learner id. The row expires after 10 minutes.
- `return_to` must be a relative path on this site. Anything else (`//`, backslashes, control characters, absolute URLs, `/auth*`, very long values) falls back to `/home`.
- The authorize URL always sends `scope=openid profile email` and S256 PKCE. It never sends a `resource` parameter.

**Callback (`/auth/zuey/callback`)**
1. Consumes the state once (`DELETE … RETURNING`), even when the callback fails.
2. Requires the same browser learner as the login. A mismatch is the `wrong_browser` error, which blocks login CSRF.
3. Checks `iss` (RFC 9207). zuey.me advertises support, so `iss` is required.
4. Exchanges the code server-side and fetches userinfo.
5. Stores the email only when `email_verified === true`.

**Member upsert** (one D1 batch):
- Upsert by `zuey_sub`.
- A deleted account's `zuey_sub` is released.
- The guest is promoted in place when the zuey account is new, or merged when a member already exists.
- The session rotates (the old one is revoked and a new token issued).
- Emits `auth.signed_in` or `auth.guest_merged`.

**Guest merge** (`guest-merge.ts`):
- Moves rows in mission_runs, evidence_submissions, evaluations, lab_runs, coach_messages, events and push_subscriptions.
- xp_ledger: duplicates (same reason+ref) are not paid twice and stay on the merged guest.
- badge_grants and concept_views: the earliest grant or view wins.
- activity_days: union of both learners' days.
- competency_scores: max score, summed evidence counts.
- certificates: a guest certificate for a level the member already has stays on the guest.
- profile_json is copied only when the member's profile is empty.
- Finally sets the guest's `merged_into` and deletes the guest's sessions.

**Other routes**
- `/auth/logout` accepts POST only, from the same origin.
- `/oauth/zuey-client.json` is the Client ID Metadata Document. It lists only the production callback.
- On loopback dev servers the client uses Dynamic Client Registration instead, cached in the CACHE KV.
- Endpoints come from zuey.me's discovery document (cached 1 hour). Discovery is rejected if the issuer differs or any endpoint is on another origin. Otherwise the hard-coded zuey.me paths are used.
- Errors land on `/auth/error?code=…`, a friendly Vietnamese page. Only the error code ever appears in the URL.

### OAuth-protected /mcp (`src/lib/mcp/**`, `src/worker.ts`, `src/pages/authorize.astro`)

- `@cloudflare/workers-oauth-provider` wraps the Astro fetch.
- The provider serves `/oauth/token`, `/oauth/register` (DCR), CIMD clients and `/.well-known/*`, including the protected resource metadata at `/.well-known/oauth-protected-resource/mcp`.
- Scopes are `learn:read` and `learn:write`. `learn:write` implies `learn:read`.
- `/authorize` is a Vietnamese consent screen that requires a member; guests are sent to sign in first.
  - It shows the client name, its CIMD domain or an "unverified" warning, and the redirect host, with a warning when the redirect is to localhost.
  - Each scope has its own checkbox.
  - The page uses the library's cookie-bound `beginConsent`/`approveConsent`, then `completeAuthorization` with `userId` and `props {learnerId}`.
- The MCP handler (SDK v2, stateless, both protocol eras):
  - Validates `Origin` against an allow-list (claude.ai, chatgpt.com, the site itself, localhost).
  - Reloads the learner on every request; a deleted learner or a guest gets 401 `invalid_token`.
  - Passes the learner to the tools through `authInfo.extra`.
- Tools:

  | Tool | Scope needed | Notes |
  |---|---|---|
  | `get_profile` | read | |
  | `list_missions` | read | |
  | `get_mission` | read | Public view: no claim answers, no correct options, no explanations, no hints, no grader rubric |
  | `start_mission` | write | Records source `mcp` |
  | `get_run` | read | |
  | `submit_evidence` | write | Requires an idempotency key; records source `mcp` |
  | `get_hint` | write | |

- Write tools declare `scopeChallenge: requireScopes('learn:write')`. A read-only token gets HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="learn:write"`.
- A `LearningError` becomes a tool error with the same code. Any other error becomes a generic `internal` error.
- The `oauth-purge` cron job (registered in `scheduled-jobs.ts`) purges expired provider grants and tokens in batches of 500, using a cursor stored in KV. It also purges expired login requests and sessions.

## Security notes

- Tokens are trusted only from our own server-side code exchange. zuey.me tokens are never stored: the access token is used once for userinfo and then dropped.
- No token, code, state or verifier is logged or put in a URL. Logs carry error codes and status numbers only, and a test asserts that a failed code is not logged.
- Session cookies are hashed at rest (SHA-256). Login requests are single-use, expire after 10 minutes and are bound to the browser.
- Login CSRF is blocked by the browser binding. CSRF on `/api/v1` is blocked by the Origin and Sec-Fetch-Site check. The consent form is protected by the library's `__Host-` consent cookie.
- `/mcp` tokens are scoped to one learner; every tool takes the learner from the token, never from the tool arguments.
- The CSP has no `form-action` directive, because the consent POST must be able to redirect to the MCP client. `frame-ancestors 'none'` and `X-Frame-Options: DENY` prevent clickjacking on the consent page.

## Test evidence

`bun run content:check && bun run test && bun run build`: content OK, 74/74 tests pass, astro check reports 0 errors, 0 warnings, 0 hints, and the build completes. `dist/_worker.js` still exports `scheduled` (in the adapter chunk).

| Suite | Tests | Covers |
|---|---|---|
| `mcp-oauth-endpoint` | 8 | Uses the real provider with in-memory KV and real-schema D1. No token gets 401 with `resource_metadata`. PRM document shape. A's token cannot read B's run. A read-only token gets 403 `insufficient_scope` on `start_mission` and `submit_evidence`. A write token starts a mission with source `mcp`. The 2026-07-28 era works. A foreign Origin gets 403. A deleted learner gets 401. |
| `mcp-tool-guards` | 6 | Scope gate, error mapping, consent scopes, the public mission view leaks no answers |
| `identity-session` | 8 | Hashing and PKCE, hash-only storage, sliding refresh and expiry, malformed cookies, merged or deleted learners, cookie flags, isAdmin |
| `identity-guest-merge` | 4 | Real SQL across every table including the xp duplicate, promotion, batch rollback, release of a deleted account's sub |
| `identity-login-flow` | 19 | `return_to` validation, single-use and expiring state, the authorize URL (scope, S256, no resource, CIMD client_id), wrong_browser, iss mismatch or missing, cancelled, failed exchange, unverified email |
| `identity-request-policy` | 24 | Same-origin rule, learner policy per path and for bots, security headers, the middleware itself (cross-origin 403 before any session work, guest cookie, bot 401), CIMD document shape |

## Changes other modules need to make

- **Settings page (platform):** sign-out must be a `<form method="post" action="/auth/logout">` button; a GET link gets 405. Sign-in is a link to `/auth/zuey/login?return_to=<path>`.
- **Learning engine:** `parseProfile` reads snake_case `profile_json` keys (it also accepts `reduced_motion`). The engine module must write the same key format.
- **All modules:** the CSP sets `connect-src 'self'`. Any client-side fetch to another origin (for example a push service or analytics) needs that origin added in `src/lib/identity/request-policy.ts`.

## Known limits

- `MCP_RESOURCE` is fixed to `https://unlock.zuey.me/mcp`. Tokens minted against `wrangler dev` will not validate, so test /mcp locally through the unit tests or on a preview deploy with the production hostname.
- zuey.me's discovery document has no `userinfo_endpoint` yet (zuey PR #382 is still open), so the client falls back to `/oauth/userinfo`. Sign-in shows the `upstream` error until that endpoint is live.
- Local sign-in against zuey.me depends on zuey.me accepting Dynamic Client Registration for loopback redirect URIs.
- An iOS home-screen app (PWA) and Safari keep separate cookies. If the zuey.me login opens in Safari, the callback lands in a browser that has a different learner and fails with `wrong_browser` (the error page explains this). This is the price of blocking login CSRF.

## Unresolved questions

- Should the merge also carry over `observer_consent` from the guest? It currently keeps the member's value.
