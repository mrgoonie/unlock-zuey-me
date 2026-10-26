# Module E report: PWA, push reminders, observer dashboard, data rights, settings

Branch `feat/pwa-observer`, part of #1. Status: complete. Gates green: `content:check`, `test` (39 tests in 8 files), `build` (astro check: 0 errors, 0 warnings).

## What was built

- **PWA.** `public/manifest.webmanifest` (vi, standalone, start `/home`, scope `/`, token colours, any + maskable icons) and PNG icons rendered from `icon.svg` with rsvg-convert: 192, 512, maskable 512, apple-touch 180, and a monochrome badge 96. `public/sw.js` serves an inline offline page for navigations, caches `/_astro/*` and `/icons/*` cache-first, never intercepts `/api/*`, and handles `push` in both the Declarative Web Push shape (`web_push: 8030`) and the plain shape. On `notificationclick` it focuses or opens a same-origin URL and POSTs `/api/v1/push/opened`. `InstallPrompt` island: an install button on Android/Chromium; Home Screen steps on iOS. `AppLayout` registers the service worker.
- **Push.** Code is in `src/lib/push/`: window math, copy, sender, subscription store, and the cron job registered in `scheduled-jobs.ts`. A conditional UPDATE on `last_sent_day` claims each send, so it is idempotent per local day. The job is capped at 100 sends per run, skips learners already active today, deletes subscriptions on 404/410, and disables after 5 failures. When the learner has an in-progress mission, the copy names that mission and links to it. Endpoints: subscribe, unsubscribe, settings (GET/PATCH), public-key, opened.
- **Consent and data rights.** Code is in `src/lib/privacy/`. `LEARNER_TABLES` drives both export and delete. A test fails if any table with a `learner_id` column is missing from it. Export omits credentials (session token hash, PKCE verifier, push endpoint and keys). Delete runs one atomic D1 batch plus R2 `ev/<id>/` removal. It also covers guest rows merged into the member, and expires every cookie the request carried, so it does not need to know the identity module's cookie name.
- **Observer.** `src/lib/observer/queries.ts` and its helpers join every statement through `consentJoin` (`consent-gate.ts`), so consent is checked inside the same SQL statement that reads the data. The `/admin` and `/admin/learners/[id]` pages are server-rendered. They show the timeline (cursor pages), funnel, hint dependence, scores and calibration, first verified win, a competency radar, readable evidence with images, and coach transcripts. Non-admins get a plain 404 page and 404 JSON.
- **Settings.** Account (guest sign-in link, or member name/email with logout), sound and reduced-motion toggles (PATCH `/api/v1/me/profile`), reminders (permission is only requested from a tap), observer consent with an explicit list of what is and is not visible, export, and delete with a typed `XOA`.

## Tests (real-schema D1 via `tests/helpers/d1-sqlite.ts`)

- `observer-consent-gate`: non-admin gets 404 on all admin routes; a non-consenting learner is never listed and gets 404 by id; revoking consent gives 404 on the next request and an empty list; re-granting restores access; no data leaks across learners; pagination.
- `privacy-data-rights`: the registry covers the schema; export holds only the learner's data (plus merged guest rows); delete empties every table for the learner and leaves others intact, removes R2 objects and expires cookies, and is idempotent; `XOA` is required.
- `push-reminder-window`: Saigon, Kolkata (+5:30), Kathmandu (+5:45), New York across DST, local-day boundary, validation, copy.
- `push-web-push-sender`: the library builds the request; the VAPID JWT is verified (aud, sub); the aes128gcm body is decrypted per RFC 8291 and asserted to be the declarative payload.
- `push-reminder-job`: once per day, mission copy and link (decrypted), skips by window/zone/activity, 404/410 cleanup, disable after 5 failures, network errors, batch limit, missing VAPID.
- `push-subscription-routes`: subscribe, settings, unsubscribe, device moves to the current learner, validation, public key.

## Files outside the listed ownership

- `docs/api-contract.md`: only the platform section, which documents three additive endpoints (`GET /push/settings`, `POST /push/opened`, `GET /admin/learners/:id/events`) and the cron rules.
- `tests/unit/observer-seed-fixtures.ts` and `tests/unit/push-test-crypto.ts`: test helpers, not test files, used only by this module's tests.
- `public/icons/icon-maskable.svg` and `public/icons/badge.svg`: source files for the PNGs.

## Integration points for other modules

- **Engine.** `GET /api/v1/evidence/<key>` must allow an admin only when the owner has `observer_consent = 1`, and must accept keys with `/`. The dashboard requests each segment URL-encoded (`ev/<id>/<file>`), which works with a `[...key]` rest route. Evidence images are expected under `ev/<learnerId>/`. Events `mission.step_viewed` and `mission.step_completed` should carry `props.stepId` (`step_id` and `step` are also read) for the funnel. `PATCH /api/v1/me/profile` must accept `{profile: {sound}}` and `{profile: {reducedMotion}}`.
- **Identity.** The middleware must set `locals.learner` (with `isAdmin` and `observerConsent`) for `/api/v1/**`, `/settings` and `/admin/**`. Same-origin POSTs from the service worker (`/api/v1/push/opened`) carry an `Origin` header. After `POST /api/v1/me/delete` the session rows are gone, and the next request should get a fresh guest.

## Not verified

- I could not run a live browser smoke test. `astro dev` needs a Cloudflare remote preview token for the AI binding, and it failed here, so the PWA install, real push delivery and the iOS flow still need a check on a device after deploy. The service worker and pages compile, and the payload format is proven by decryption in the tests.

## Unresolved questions

- Should `push.opened` instead go through the engine's `POST /api/v1/events` allow-list? I used a dedicated `/api/v1/push/opened` so the click report does not depend on the engine's allow-list.
