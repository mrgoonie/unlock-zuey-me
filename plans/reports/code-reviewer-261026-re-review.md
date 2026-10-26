# Re-review of PRs #12–#15 (unlock-zuey-me @ origin/main 21f1872)

## Scope
- Range: `59c04d5..21f1872` (PR #12 1f03698, #13 9797ea8, #14 baa1911, #15 21f1872). 90 files changed, +3195/−433.
- Focus: whether the earlier findings H1, M1–M4 and L1–L9 are fixed; new bugs; migrations 0003/0004 against live data; answer-key exposure; cost and abuse.
- The previous report (`code-reviewer-261026-final-review.md`) is **not on main**. I mapped the findings from the PR fix reports in `plans/reports/fullstack-developer-261026-{abuse-and-cost-caps,hardening-small,learning-integrity}.md`.
- Checks:
  - `bun install` ran.
  - `bun run test`: **39 files, 338 tests, all pass**.
  - `bun run build`: **exit 0, 0 errors, 0 warnings**. There is one pre-existing TS deprecation hint for `execCommand` in `CopyButton.tsx`.
  - e2e was not run, because it targets production and the brief forbids that.
- Answer-key leak check on the build output: an explanation string from `content/missions/compare-before-buying.yaml` appears only in `dist/_worker.js/chunks/loader_*.mjs`. It appears in no file under `dist/_astro/` (the client bundles).

## Overall verdict
The fixes are real and mostly well built:
- Guarded D1 batches, reserve-then-settle AI budgets, an allow-list mission view, XP keyed by mission, and a partial unique index.
- The migrations are additive. The data-rewriting statements are order-independent and covered by a test.

No Critical or High issues found. One Medium remains, carried over from H1: the AI **cost** is now capped, but the **availability** of AI grading is not protected. There are also a few Low issues.

---

## 1. Previous findings: verification

| ID | Status | Evidence |
|---|---|---|
| H1 AI budget abuse via unlimited guests | **Cost fixed; availability not fixed (see N1)** | Per-IP throttles before guest creation: `src/middleware.ts:33-37,43,46`. Rules: `src/lib/identity/request-rate-limits.ts:13-44`. Atomic reservation: `src/lib/coach/ai-usage.ts:85-106`. Gateway reserve/release/settle: `src/lib/coach/ai-gateway.ts` (OpenRouter loop and Workers AI reservation). Global Workers AI cap from `wrangler.jsonc` vars. |
| M1 merged-guest evidence ownership | **Fixed** | `src/lib/learning/evidence-store.ts` `resolveKeyOwner` (merge chain plus deleted check) is used by `assertOwnedEvidenceKeys` and `readEvidence`. Admin consent follows the member. `src/lib/observer/queries.ts` excludes merged guests from both the list and the detail view. |
| M2 answer keys in browser | **Fixed** | `src/lib/learning/learner-mission-view.ts:64-120` builds the view field by field. `src/pages/missions/[slug]/run.astro:14` passes only that view. `src/lib/learning/mission-runs.ts:87-93` uses the view on GET. `src/lib/learning/answer-reveals.ts:64-74` holds keys back until completion or a reveal. `src/pages/api/v1/runs/[id]/submit.ts` follows the same rule. MCP `get_mission` still uses `missionPublicView`. The bundle grep is clean. |
| M3 XP farming by repeats | **Fixed** | `src/lib/learning/finalize-evaluation.ts:52-56`: the ledger `ref` is now `mission.id`, so `INSERT OR IGNORE` pays once. `migrations/0004_learning_integrity.sql` re-keys existing rows with `UPDATE OR IGNORE`, which handles collisions correctly. XP has no other source (`grep xp_ledger`). |
| M4 unthrottled write endpoints | **Fixed** | Per-IP and per-learner limiters: `src/middleware.ts:35,60`. Lab cap with one atomic `INSERT…SELECT`: `src/lib/learning/labs-and-concepts.ts`. Push device cap in the same batch: `src/lib/push/subscription-store.ts`. Bounded, paged export with an allow-listed table name: `src/lib/privacy/export-learner-data.ts:146-150`. |
| L1 return_to `//` | Fixed | `src/lib/identity/login-requests.ts:29-30` |
| L2 Workers AI timeout + finalize rev | Fixed (both halves) | Timeout: `src/lib/coach/ai-clients.ts:86-103`. The finalize evaluation insert and every later write in the batch are guarded on `evaluating` at the claimed rev (`finalize-evaluation.ts:42-70`, `evaluation-repository.ts`). |
| L3 submission + claim atomic | Fixed | `src/lib/learning/submit-evidence.ts:99-105` |
| L4 one open run | Fixed | Migration 0004 dedupe plus partial unique index. Race fallback: `mission-runs.ts:53-60`. Merge abandons the older run: `guest-merge.ts:25-31`. |
| L5 HSTS/CSP | Fixed | `src/lib/identity/request-policy.ts:70,86,103` |
| L6 upload focus ring | Fixed | `EvidenceImageUpload.tsx:55-61`: a `peer sr-only` input before the label. |
| L7 MCP get_hint errors | Fixed | `src/lib/mcp/tools/run-tools.ts` description. |
| L8 grant revocation on erase | Fixed | `src/lib/privacy/delete-learner-data.ts:59-60`. `src/pages/api/v1/me/delete.ts` passes the helpers. Grant `userId` = learner id (`authorize-consent.ts:79`). |
| L9 push > 100 per window | Fixed | `src/lib/push/reminder-job.ts:92-116`. It loops with claim-then-send and a look-back. The claim keeps rows from repeating, so the loop ends. |

## 2. Answer-key serialization paths

These are all the paths that send mission data:
- `run.astro` island props: learner view.
- `GET /api/v1/runs/:id`: learner view, plus an `answerKey` that holds only revealed items until completion.
- `POST …/submit`: `answerKey` is full only when `completed`.
- `POST …/reveal`: only a quiz or prediction item that the learner has already answered and saved. Verification claims are rejected (`answer-reveals.ts:32-39`).
- MCP `get_mission`: `missionPublicView`.
- MCP `get_run` and `start_mission`: run only.
- Hints and practice-chat context: `stepInstruction`, which contains no keys (`coach/step-context.ts:10-19`).
- Rubric feedback: counts only.
- Mission detail page (`missions/[slug]/index.astro`): metadata only, SSR.

**No path ships keys before grading.**

Remaining by-design exposure: authored hint level 4 may state the answer. It is not locked by a reveal. This is a design choice, not a bug.

Dead code: `getMissionContent` (`src/lib/learning/service.ts:39-43`) still returns the full `Mission` and has no callers. It would leak keys if someone wired it to a route later. Informational.

---

## 3. New findings

### Critical
None.

### High
None.

### Medium

**N1. One client can exhaust the global AI budgets and disable grading for everyone until the UTC day ends (CONFIRMED code path; exploit cost PLAUSIBLE).** This is the residual of H1.
- The caps are purpose-agnostic, and practice chat (open to guests by policy) competes with grading.
- Numbers, all from code and config:
  - Global OpenRouter budget: $5/day. Per learner: $0.30/day, so about 17 guests drain it.
  - Guest creation: 20/min/IP.
  - Chat: 30 req/min/IP, plus 60/day per learner.
  - Workers AI global cap: 2000/day.
- From one IP, the OpenRouter global budget falls within minutes to a few hours. Workers AI falls in about 67 minutes at 30/min. Distributed IPs are faster.
- After that, `runAi` throws `AiUnavailableError('budget')` for every purpose. `submitEvidenceImpl` then finalizes every learner's submission as `evaluation_failed` (`submit-evidence.ts:118-126`). Evidence is kept, but no one can pass a mission for the rest of the day.
- The 2000/day cap itself is owner policy. The issue here is that grading has no protected share of the budget.
- Fix: give caps per purpose. For example:
  - `chat` and `hint` may use at most about 50–60% of each global cap, enforced by the same conditional `UPDATE` with a per-purpose global row such as `'*chat'`.
  - Or `grade` alone may use the last X% of the budget.
  - Optionally, a lower per-guest USD cap than per-member.
  - Also consider a deterministic-only grading result when AI is unavailable and every AI criterion can be scored partially.

### Low

**N2. A hint timeout loses the hint and charges the ladder again (CONFIRMED).**
- The client hint timeout is 20 s (`api-client.ts` `DEFAULT_TIMEOUT_MS`). The server worst case is 15 s (`hint-coach.ts:74`, one coach model) plus 30 s of Workers AI, about 45 s.
- PR #15 removed the client's static-hint fallback (`HintLadder.tsx`), so a slow provider now shows an error.
- The server has already run the ladder `UPDATE` (`hints.ts:25-29`): `hints_used+1` and the level unlocked. The generated hint is stored in `coach_messages` but never shown.
- Retrying asks for the same level again: one more AI call and one more `hints_used`.
- Fix: a client timeout of 50 s or more for hints. Or a server-side deadline that returns the static hint after about 15 s. Or let the client fetch the stored hint for (run, step, level) on retry.

**N3. A locked answer in a local draft wedges autosave and submit (CONFIRMED path; trigger PLAUSIBLE).**
- `autosave-queue.ts:60-70` handles only `conflict`. A `forbidden` from `assertRevealedUnchanged` makes `drain` return false and leaves the step dirty.
- Every later drain starts with the same step (`stepIds[0]`), so other steps never save.
- Then `settle()` fails, and submit shows the misleading "network" message (`use-run-session.ts:199-202`).
- Trigger: unsaved edits on device A, a reveal of the same item on device B, then device A resumes. `restoreDraft` re-applies the local dirty value over the server answer. A stale tab can do the same.
- Fix:
  - On `forbidden`, re-fetch the run, drop dirty flags and local values for locked fields (`run.revealed`), and continue.
  - Make `restoreDraft` prefer server values for revealed items.

**N4. "Làm lại" with the full key visible can satisfy certificate eligibility (CONFIRMED; may be intended).**
- A completed run exposes every verification verdict (`answer-reveals.ts:65`). A new run can then be passed with known verdicts.
- XP is safe (once per mission). But competency EMAs still update (`finalize-evaluation.ts:57-64`).
- `hasStrongVerify` accepts any passed evaluation (`certificates.ts:36-41`), so the "verify ≥ 0.8" certificate condition can be met by redoing a mission after seeing the key.
- Owner decision needed: skip competency updates and strong-verify credit for runs after the first pass, or accept this.

**N5. Guest cleanup can race a sign-in merge (PLAUSIBLE, narrow window).**
- `removeInactiveGuests` selects ids (`inactive-guest-cleanup.ts:28-44`) and only later calls `deleteLearnerData` per id.
- If the guest is merged in between, `deleteLearnerData(guestId)` deletes R2 objects under `ev/<guestId>/`. Those objects are now owned by the member and referenced by the member's submissions (M1 keeps the guest prefix). It also deletes the guest learner row, which breaks `resolveKeyOwner` for any image that remains.
- Fix: re-check `merged_into IS NULL` and inactivity just before deletion, or pass a guard that aborts when the guest is merged.

**N6. Cron jobs share one invocation's subrequest budget (PLAUSIBLE).**
- `runScheduledJobs` runs four jobs in parallel in one invocation:
  - push reminders: up to 1000 sends of about 5 calls each;
  - evidence GC: up to 2000 objects per run, about 3 D1 queries per distinct owner (`orphan-evidence-cleanup.ts:39-58`);
  - guest cleanup: 50 erasures.
- Each job is budgeted on its own. Under a scripted upload burst across many guests, the combined count could pass the per-invocation subrequest limit. Later calls would then throw. They are caught by `allSettled`, but the push loop would stop part-way. This depends on how bindings count against the current Workers plan limit (unverified).
- Fix: one shared budget, or run the jobs in sequence with per-job caps that add up below the limit.

**N7. Deploy window between migration 0004 and the new worker (PLAUSIBLE, low impact).**
- `deploy.yml` applies migrations, then deploys. For the seconds or minutes in between, the old worker still keys `mission_pass` by run id. A repeat pass in that window gets paid again.
- The old `start` code can also hit the new unique index on a double-tap and return 500.
- Accept, or deploy at low traffic.

**N8. Accessibility of the reveal UI (CONFIRMED).**
- In `QuizSteps.tsx:70-77,109-118`, the focused "Kiểm tra" / "Chốt dự đoán" button is unmounted when the key arrives, so keyboard and screen-reader focus falls to `<body>`. `role="status"` announces the result, but the user loses their place.
- Fix: move focus to the reveal panel (`tabIndex={-1}` plus a ref).
- Pre-existing: the ✓ marker uses `aria-label` on a plain `<span>`, which many screen readers ignore. Use visually hidden text instead.

**N9. No way out of an open run (PLAUSIBLE, future content).**
- There is no abandon endpoint, and `again:true` returns the open run. A `needs_revision` run whose locked (revealed) answers make `pass_score` unreachable would block the mission for that learner for good.
- Current content is safe: the largest locked weight is 10 (`prediction_correct`) against a pass score of 0.7, and there are no `quiz_correct` criteria.
- Fix: a `content:check` rule saying that the sum of revealable-criterion weights must stay below `1 − pass_score`. Or an abandon or restart action for open runs.

## 4. Migration safety (0003, 0004)
- **0003**: an `ADD COLUMN … NOT NULL DEFAULT 0` and two `CREATE INDEX`. Safe on live data.
- **0004**:
  - **Dedupe**: it abandons every open run that has a newer open sibling. The result does not depend on row order, because the newest run never has a newer one. It matches the partial index predicate, and the index is created after the dedupe. Abandoned rows keep their answers but can no longer be reached from the UI. Any localStorage draft for those runs is orphaned. This is acceptable.
  - **Re-key**: `UPDATE OR IGNORE` keeps the first row per (learner, mission_pass, mission) and leaves later rows under their run ids, so XP totals do not change. Merged guest duplicates that stayed on the guest are unaffected.
  - One edge: an `evaluating` run abandoned by the dedupe makes its in-flight finalize conflict. This is harmless.
- `tests/unit/migration-learning-integrity.test.ts` covers both statements.

## 5. Other checks with no issues found
- **CSRF**: the middleware same-origin check runs before the limiter. `/reveal` is a POST under `/api/v1`, so it is covered. The `/reveal` body is a strict zod schema.
- **Concurrency**:
  - reveal and save use an optimistic rev;
  - starts race on the unique index and fall back;
  - stale finalize writes nothing;
  - the reservation `UPDATE` touches both rows or neither (it is a self-referencing subquery, which SQLite evaluates before any row changes);
  - the push cap delete runs in the same batch as the upsert;
  - the lab cap is one statement.
- **Export paging**: the table name is allow-listed, and `after` is a safe integer. Every learner table is a rowid table.
- **Chat**: forged assistant turns are dropped (`practice-chat-service.ts:50-61`). Stored replies match what the client gets, because the reply is the same string.
- **Certificates**: guests are rejected after the eligibility check (`certificates.ts:54`), as the policy requires.

## Recommended actions (priority order)
1. N1: protect a share of the global AI budget for grading (caps per purpose).
2. N3: handle `forbidden` in the autosave queue, and prefer server values for revealed items when restoring.
3. N2: line up the hint client timeout with the server worst case, or add a server deadline that falls back to the static hint.
4. N5: re-check merge status before guest erasure.
5. Owner decision on N4. Then N6, N8, N9 as hardening. Remove or restrict `getMissionContent`.

## Metrics
- Tests: 338/338 pass (39 files). Build: 0 errors.
- Lint: no separate lint script was run (the build's type check is clean).

## Unresolved questions
1. N4: should runs after the first pass count toward competency and certificate "strong verify"?
2. N1: what share of the global AI budget should practice chat (guest-available) be allowed to use?
3. Does the previous final-review report exist elsewhere? It is not on main, so the L1–L9 mapping comes from the PR fix reports.

Status: DONE_WITH_CONCERNS
Summary: needs fixes. Critical 0, High 0, Medium 1 (N1, confirmed), Low 8 (N2, N3, N4, N8 confirmed; N5, N6, N7, N9 plausible). Of the earlier findings, 13 are fully fixed; H1's cost half is fixed and its availability half remains as N1.
