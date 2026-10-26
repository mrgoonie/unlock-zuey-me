# Final code review: mrgoonie/unlock-zuey-me @ origin/main (59c04d5)

Date: 2026-10-26 (Asia/Saigon). Reviewer: code-reviewer (independent). Scope: whole codebase at `origin/main`, about 13.5k LOC in `src/` plus `migrations/` and `public/sw.js`.
Checks: `bun run test`: 32 files, 276 tests pass. `bun run build` (astro check + build): 0 errors, 0 warnings, build complete.
Excluded as already known: autosave/submit race in `use-run-autosave.ts`, and the missing timeouts on `startMission`/`getRun` in `api-client.ts`.

## Verdict

Needs fixes. I found no Critical issue. Session handling, the OAuth login (state, PKCE, binding the login to the browser, `iss`), MCP token→learner binding and scopes, the CSRF origin gate, consent-gated observer SQL, export/delete coverage and XSS surfaces all hold up. One High issue (cost/abuse) and four Medium issues should be fixed before the "independent review clean" box is ticked.

Counts: Critical 0 · High 1 · Medium 4 · Low 9

---

## High

### H1. AI spend and storage can be abused without limit by rotating guests. One script can drain the global AI budget for everyone (confirmed by code)
- `src/middleware.ts:31-35` + `src/lib/identity/request-learner.ts:37-41`: any `/api/v1` request with a browser-like User-Agent and no cookie creates a new guest learner and session. There is no per-IP or global cap on guest creation.
- All AI limits are keyed by `learnerId`:
  - `src/lib/coach/rate-limit.ts:14` keys the rate limit as `rl:<scope>:<learnerId>`.
  - `src/lib/coach/ai-usage.ts` enforces a per-learner USD budget.
  - `src/lib/coach/ai-models.ts:24`: `WORKERS_AI_DAILY_REQUESTS_PER_LEARNER = 60`.
  - The only global cap is the OpenRouter USD budget (`ai-gateway.ts:86-90`). **Workers AI has no global cap at all** (`ai-gateway.ts:111-114` checks only `usage.learner.workersAiRequests`).
- `POST /api/v1/coach/chat` works as a general LLM proxy. It accepts client-supplied history, including forged `assistant` turns, of up to 12 × 4000 chars per call (`practice-chat.ts`, `practice-chat-service.ts:28-38`).
- **Failure scenario:** a script loops `curl -A "Mozilla/5.0" -X POST /api/v1/coach/chat` without a cookie. Each request is a fresh guest with a fresh $0.30 budget, 60 chats/day and 60 Workers AI calls.
  - Within minutes the global $5 OpenRouter budget is gone for every learner. Grading then drops to the fallback model.
  - After that, Workers AI spend keeps growing with no upper bound.
  - Every request also writes `learners` + `sessions` rows that are never purged (only expired sessions are purged, never guest learners).
- The same per-learner-only pattern applies to `POST /api/v1/evidence/upload` (20 × 5 MB per minute per guest; R2 objects uploaded but never submitted are never garbage-collected).
- **Aggravating factors:**
  - `readUsage` → call → `recordUsage` is check-then-act (`ai-gateway.ts:67-103`). N concurrent requests from one learner all pass the budget check, so the per-learner cap can be overshot by the concurrency factor.
  - The KV limiter is read-then-put, so it is not atomic either.
- **Fix:**
  - (a) Add a Cloudflare Rate Limiting binding (or a Durable Object counter) keyed by `CF-Connecting-IP` on guest creation and on `/api/v1/coach/chat`, `/runs/*/hints`, `/runs/*/submit` and `/evidence/upload`.
  - (b) Add a global daily Workers AI request cap next to the global USD cap. For example, count `workers_ai_requests` on the `'*'` row that `recordUsage` already writes, and check `usage.global.workersAiRequests`.
  - (c) Optionally require a member account (or a minimum guest age/activity) for practice chat.
  - (d) Add a cron that deletes guest learners with no activity after N days, and R2 `ev/` objects not referenced by any submission after 24 h.

---

## Medium

### M1. Merging a guest into an existing member orphans the guest's evidence images (confirmed by code)
- Evidence keys embed the uploader's id: `ev/<learnerId>/<id>.<ext>` (`src/lib/learning/evidence-store.ts:13,36`).
- `guestMergeStatements` (`src/lib/identity/guest-merge.ts:16-27`) moves `evidence_submissions` rows to the member, but `image_keys_json` still points at `ev/<guestId>/…`.
- Ownership and consent are then judged by the key prefix, not by the row owner:
  1. **Owner loses access:** `readEvidence` (`evidence-store.ts:60-65`) requires `owner === viewer.id`. The member now gets 404 for their own pre-merge screenshots (runner previews, results).
  2. **Retry breaks:** a guest run in `evaluation_failed` with images, signed in with an existing zuey account, then "Chấm lại" fails. `submit-evidence.ts:83-87` reuses `previous.imageKeys`, and `assertOwnedEvidenceKeys` (`evidence-store.ts:47`) rejects them with "Ảnh đính kèm không hợp lệ". Any draft with images uploaded before the merge fails the same way. The learner is stuck until they remove the images.
  3. **Consent is enforced against the wrong row:** for admins, `ownerConsents(db, owner)` checks the *merged guest's* `observer_consent`, not the member's.
     - If the guest row had consent=1 and the member later revokes, `GET /api/v1/evidence/ev/<guestId>/…` still serves the image to an admin who saw the key earlier. That breaks "revoking hides immediately" (plan item 9).
     - If the member consents but the guest didn't, the admin dashboard shows broken images.
  4. A related gap: `getObservedLearner` (`src/lib/observer/queries.ts:51-54`) does not filter `merged_into IS NULL`. An admin can still open `/admin/learners/<mergedGuestId>` under the guest's old consent. The list does filter it.
- **Fix:**
  - Authorize evidence reads by the row owner, not the key prefix. Resolve `owner` via `SELECT learner_id FROM evidence_submissions WHERE image_keys_json LIKE …`, or better, resolve `merged_into` for a key's owner id (`owner === viewer.id || mergedInto(owner) === viewer.id`; admin consent checked on the resolved active learner).
  - Accept keys of merged guests in `assertOwnedEvidenceKeys`.
  - Add `AND l.merged_into IS NULL` to `getObservedLearner`.
  - Alternatively, copy R2 objects to the member prefix at merge time and rewrite `image_keys_json`.

### M2. Rubric answer keys ship to the browser, so deterministic criteria (including the "verify" criterion that gates certificates) can be read from page source (confirmed by code)
- `src/pages/missions/[slug]/run.astro:16` passes the full `Mission` as island props. `GET /api/v1/runs/:id` (`mission-runs.ts:52-59` → `getRunDetail`) returns the raw `Mission` too. This includes:
  - `verification.claims[].answer` and `explanation`
  - `quiz.questions[].correct`
  - `prediction.correct`
  - rubric `check`/`guidance`
- `VerificationStep.tsx:2-3` states the intent ("Explanations are not shown here: the verdicts are graded, the reference answers appear after passing"), and the MCP view deliberately strips the same fields (`src/lib/mcp/mission-public-view.ts:1-5`). The web path contradicts both.
- The "reveal locks the answer" rule for quiz/prediction exists only in client draft state (`QuizSteps.tsx:1-3`). `saveAnswers` accepts a changed choice after reveal.
- **Failure scenario:** a learner opens view-source (or the network tab), reads the `claims_score` verdicts, and scores 1.0 on the `verify` criterion. Certificate eligibility (`certificates.ts:35-40`, "verify ≥ 0.8") and the `prediction_correct` / `quiz_score` criteria then mean nothing.
- **Fix:**
  - Serve a learner view of the mission to the client: reuse `missionPublicView` or a sibling that keeps what the UI needs before submit.
  - Return claim answers and explanations only in the evaluation response after the run is evaluated, or only when `completed`.
  - For quiz/prediction reveal, add a server endpoint that records the reveal on the run and returns the explanation, and reject edits to revealed fields in `saveAnswers`.

### M3. XP can be farmed by re-running completed missions, which inflates levels and certificate levels (confirmed code path; product intent to confirm)
- `startMissionImpl` (`mission-runs.ts:36-48`) creates a new run whenever no open run exists. The runner page calls `startMission` on every load (`use-run-session.ts:65`). Visiting `/missions/<completed>/run` therefore silently starts a fresh run instead of showing the result.
- XP uniqueness is `(learner, 'mission_pass', run.id)` (`finalize-evaluation.ts:46-49`), so each re-pass pays full XP again (pasting the same answers works).
- `issueCertificate` takes its level from total XP (`certificates.ts:52`). Repeating one cheap mission can reach L3 "Builder" on a public certificate.
- A UX symptom of the same cause: a learner returning to a finished mission sees an empty new run, and the completed result is not reachable from the runner.
- **Fix (pick one):**
  - Pay mission XP once per `(learner, mission)`, i.e. `ref = mission.id`, or reduced XP for repeats.
  - Or make the runner open the latest completed run read-only and require an explicit "Làm lại" action, without counting XP from repeats toward certificate level.

### M4. Several write endpoints have no throttle, so the DB grows without bound (confirmed by code)
- These endpoints insert one row per call with no rate limit:
  - `POST /api/v1/events` (`client-events.ts`)
  - `POST /api/v1/labs/:id/result` (`labs-and-concepts.ts:28`, up to 4 KB `lab_runs` row + event + badge evaluation)
  - `POST /api/v1/missions/:id/start` (new run each time after completion; see M3)
  - `POST /api/v1/push/subscribe` (any syntactically valid FCM URL; the cron later POSTs to them)
- Combined with guest rotation (H1), D1 storage and row-read costs are unbounded.
- `exportLearnerData` (`export-learner-data.ts:39-43`) runs `SELECT *` per table with no limit. A learner who spams events can make their own export exceed Worker memory or CPU.
- **Fix:** apply the same per-IP/per-learner limiter as H1. Cap `lab_runs` per (learner, lab, day). Cap push subscriptions per learner (for example 10). Stream or paginate the export.

---

## Low

- **L1. `validateReturnTo` is not idempotent. Not exploitable today (confirmed).**
  - `src/lib/identity/login-requests.ts:20-32` returns `//evil.com` for `/.//evil.com`, `/..//evil.com` and `/%2e%2e//evil.com` (verified with bun), because the dot segments are normalized *after* the `//` check.
  - The open redirect is neutralized only because `consumeLoginRequest` (`:67`) validates a second time.
  - Any future caller that redirects to the single-pass result becomes an open redirect.
  - Fix: after building `url`, reject when `url.pathname.startsWith('//')` (or re-run the prefix checks on the output), and add these cases to the tests.
- **L2. `workersAiChat` has no timeout** (`src/lib/coach/ai-clients.ts:94-105`).
  - A hung Workers AI call holds the submit request open. After 3 min (`STALE_EVALUATING_MS`) the run appears `evaluation_failed`, and a retry can run a second evaluation in parallel: two evaluation rows, competency EMA applied twice. XP stays single thanks to `INSERT OR IGNORE`.
  - Fix: wrap the call in `Promise.race` with about 30 s, and make the finalize `UPDATE` check `rev` so a late finisher is discarded.
- **L3. A crash between claiming a run and storing the submission can re-grade stale answers (plausible, narrow window).**
  - If the Worker dies after the claim UPDATE (`submit-evidence.ts:92-96`) but before `insertSubmissionStatement` (`:106`), the run shows `evaluation_failed` after 3 min.
  - The web retry sends no `answers`, so `previous = latestSubmission` is the *older* submission from a needs_revision cycle. The claim then overwrites `answers_json` with those old answers, and the learner's revisions are lost.
  - Fix: insert the submission in the same `db.batch` as the claim, or on retry prefer `run.answers` when `run.updatedAt > previous.createdAt`.
- **L4. Duplicate open runs.** There is no unique index on open `(learner_id, mission_id)`.
  - Concurrent `startMission` calls, or a guest→member merge where both sides had the mission open, leave two open runs. `findOpenRun` picks one and the other lingers in `activeRuns`.
  - Fix: add a partial unique index (`WHERE status NOT IN ('completed','abandoned')`) and abandon the older run on merge.
- **L5. Defense-in-depth headers.**
  - The CSP allows `script-src 'unsafe-inline'` (`request-policy.ts:68`) and `img-src https:`, and there is no HSTS header.
  - I found no XSS sink (no `set:html`/`innerHTML`; Astro/React escape everything, including admin evidence and certificate names), so the risk is low.
  - Consider nonce-based scripts later and `Strict-Transport-Security`.
- **L6. A11y: the screenshot upload control has no visible keyboard focus.**
  - The `<input type=file class="sr-only">` sits inside a styled label (`EvidenceImageUpload.tsx:54-58`). The focus ring lands on the 1 px clipped input.
  - Fix: add `.btn-ghost:has(input:focus-visible){ring…}`, as `.choice` already does.
  - Other learner screens look fine: labelled radios/fieldsets, `aria-live` counters, skip link, reduced motion honoured by CSS, `CountUp` and confetti.
- **L7. Contract mismatch.** The MCP `get_hint` description says a hint level that is not unlocked yet returns `invalid`. `hints.ts:30` throws `forbidden`. Align one of them.
- **L8. Delete does not revoke `/mcp` grants.**
  - `deleteLearnerData` leaves OAuth grant/token records (userId = learner id, client metadata) in `OAUTH_KV` until they expire.
  - Access is already refused because `loadLearnerContext` returns null, so this is data-minimisation only.
  - Fix: call `listUserGrants` / `revokeGrant` for the learner during deletion.
- **L9. Push cron drops reminders beyond 100 per quarter-hour.**
  - `MAX_SENDS_PER_RUN = 100` (`reminder-job.ts:20`) is shared across all time zones.
  - Subscriptions due in the same window beyond 100 are skipped for the whole day, because the next run looks at the next window.
  - Fix: let the window look back over not-yet-sent subscriptions for the day (`remind_time <= now`), or raise or paginate the cap.

## Verified as correct (to calibrate the findings)
- **Sessions:** 32-byte random tokens, only the SHA-256 is stored, the cookie is HttpOnly/Secure/Lax, the session rotates at sign-in, merged and deleted learners are rejected at resolve time, and logout is same-origin checked.
- **OAuth login:**
  - state is single-use (`DELETE … RETURNING`) with a 10 min TTL;
  - PKCE S256;
  - login CSRF is blocked by binding the request to the browser's learner;
  - `iss` is checked when present or required;
  - discovery endpoints must be same-origin as the issuer;
  - tokens and codes are never logged;
  - email is stored only when `email_verified`, and `isAdmin` = member + verified email in `ADMIN_EMAILS`.
- **MCP:**
  - the learner comes only from token `props`, and non-member, deleted or merged learners get 401;
  - write tools require `learn:write` (HTTP challenge + handler gate);
  - the consent POST needs a member session plus a browser-bound handle, and scopes are filtered to known ones;
  - run access is `WHERE id = ? AND learner_id = ?` → `not_found`;
  - `get_mission` strips the answer keys.
- **CSRF:** every state-changing `/api/v1` request is origin-checked in middleware (including SW-originated POSTs).
- **Observer:** every query joins `consentJoin` in the same SQL statement. Non-admins get 404 everywhere.
- **Export/delete:** `LEARNER_TABLES` covers every `learner_id` table (a test enforces this), merged guests and R2 prefixes are included, credentials are omitted from the export, and the delete is one atomic batch.
- **Submit:** same-key replay grants nothing, the claim uses rev+status, the submission is stored before AI, AI failure leads to `evaluation_failed` with the evidence kept, and XP goes through `INSERT OR IGNORE`.
- **Grader prompt:** learner text is fenced with a random boundary, the output is strict-schema + zod (each criterion exactly once, scores clamped), and images are never sent to the model.
- **Uploads:** magic-byte sniffing, 5 MB cap, served with `nosniff` + `default-src 'none'` CSP.
- **Cron:** `waitUntil` + `allSettled`; push claims are idempotent per day.

## Recommended order
1. H1: IP rate limiting + global Workers AI cap + guest/R2 GC.
2. M1: evidence ownership via the merge chain + `getObservedLearner` merged filter.
3. M2: learner view of the mission without answer keys; server-enforced reveal.
4. M3: decide the repeat-XP policy; open completed runs read-only.
5. M4, then the Low items.

## Unresolved questions
1. Is repeat XP for the same mission intended (M3)? The contract says only "once per run".
2. Should guests be allowed to use practice chat at all, or only members (H1)?
3. Should certificates be issuable to guests with an arbitrary public display name on unlock.zuey.me (impersonation risk), or members only?
