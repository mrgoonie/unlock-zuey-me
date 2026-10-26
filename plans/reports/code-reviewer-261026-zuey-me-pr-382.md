# Code Review: zuey-me PR #382 (identity scopes + /oauth/userinfo)

Branch `feat/oauth-identity-userinfo` @ f3cffc7 (base ee93226). Worktree `/Volumes/GOON/www/zuey/zuey-me-wt-oauth-identity`. No REVIEW.md in the repo.

## Scope
- Files: 14 (+546/-21). Core: `src/lib/oauth/{config,authorize,caller,tokens,userinfo,metadata,openapi,scope-copy}.ts`, `src/pages/oauth/userinfo.ts`, `src/lib/csrf-origin-check.ts`, `src/pages/api/openapi.json.ts`, `ConnectedApps.tsx`, README, `tests/oauth-identity-userinfo.test.ts`
- Checks run: new test file 14/14 pass; oauth-mcp + identity tests 63/63 pass; full `bun test` 2286/2286 pass; `bun run build` (astro check 0 errors + build) OK.

## Overall
Change is additive and the audience model holds. I traced every path that accepts a token:
- `/mcp`: `validateAccessToken(..., mcpResourceFor)` rejects tokens bound to `/oauth/userinfo`. The new guard at `caller.ts:62` also rejects `/mcp`-bound tokens that carry only identity scopes. That covers the case where the member unticked every MCP scope, and the case where the client narrowed scopes on refresh (`tokens.ts:224`).
- `/api/mcp` + REST: `resolvePrincipal` never accepts `zoa_` tokens. Existing behaviour is unchanged and tested.
- `isMemberScope` now excludes identity scopes, so `principal.scopes` never contains `openid`/`profile`/`email`. Only `caller.ts` uses it.
- Admin: `buildView` (`authorize.ts:179`) never offers admin on identity-only requests. On mixed requests admin works as before, and `decideConsent` filters on what was offered. Unchanged for MCP clients.
- PRM `scopes_supported` (`metadata.ts:40`) is unchanged, so ChatGPT-style clients ask for the same scopes as before.
- Revoked/expired/deleted users: `validateAccessToken` joins on `deleted_at IS NULL` and checks consent, token revocation and expiry → 401. Tested for revoked, expired and deleted.
- Rollback is safe. If old code runs, `parseStoredScopes` drops unknown scopes, and identity-only tokens stay audience-bound to `/oauth/userinfo`, so `/mcp` still rejects them.

No critical or high findings.

## Critical Issues
None.

## High Priority
None.

## Medium Priority

**M1. The member can untick `openid` on a sign-in consent, which leaves the RP holding a token that userinfo always rejects.** `authorize.ts:216-217`, consent template `src/pages/oauth/authorize.astro` (scope checkboxes).
Scenario: unlock.zuey.me requests `openid profile email`. The member unticks `openid` and keeps `email`. The code is issued with `[email]` and the token response has `scope: "email"`. Userinfo returns 403 `insufficient_scope`, so sign-in fails with an opaque error. The consent and connected-app row are still recorded, and a 90-day refresh token is issued for a token that cannot do anything.
Fix: when `pending.scopes` includes `openid` and the request is identity-only, require it. Either render the checkbox checked+disabled and add `openid` server-side in `decideConsent`, or redirect back with `error=no_scope` when `openid` is missing. The same could apply to mixed requests, but there it is optional.

**M2. Userinfo does not tell the RP which client the token was issued to (no `aud`/`client_id`), and there is no ID token.** `userinfo.ts:72-80`.
`validateAccessToken(d1, token, null)` accepts any live token with `openid`, from any client and any audience. This is safe for unlock.zuey.me as long as it only uses tokens it got from its own back-channel code exchange (PKCE + state + `iss`). If unlock or a future RP ever accepts a bearer token from a client (mobile app, SPA, API), that is the classic OAuth-login token-substitution hole. Any other app the member authorized with `openid` (e.g. a DCR MCP client granted `openid email articles:read`) could present its token and be logged in as the member.
Fix (cheap, additive): add `client_id` (or `aud` = client_id) to the userinfo response so RPs can check it. Also state in the README/OpenAPI that RPs must only trust tokens they obtained themselves.

## Low Priority

**L1. AS metadata `scopes_supported` now lists `openid profile email` (`metadata.ts:19`).** Older MCP clients that build their scope request from AS metadata instead of PRM will now send identity scopes too. Their request stays `/mcp`-bound and works, but their consent screen gains 3 pre-ticked boxes, and their tokens can read the member's email at userinfo. This is a visible consent change for that class of client. It is acceptable, but it contradicts "consent behaviour must not change for existing clients". It could be avoided by keeping identity scopes out of the AS list. That is not RFC-required, but it would hurt discovery for RPs.

**L2. The email consent copy says "đã xác minh" (verified) (`scope-copy.ts:15`), but the claim is returned even when `email_verified_at` is null** (`userinfo.ts:34`, then `email_verified: false`). In practice almost every user is verified, because users are created through `findOrCreateVerifiedUser` and email change re-verifies at `login-tokens.ts:165`. Either fix the copy, or have the RP (unlock) treat `email_verified !== true` as untrusted for account linking.

**L3. `validateAccessToken` now takes `audience: string | null` (`tokens.ts:278,291`).** It is an exported security primitive, and `null` silently disables the audience check. Today it has one caller and that caller is correct. A future caller passing a nullable variable would fail open. Prefer a separate `validateAccessTokenAnyAudience` wrapper, or an explicit allowlist (`[mcp, userinfo]` for the issuer).

**L4. `/mcp` answers 401 `invalid_token` for a valid `/mcp`-bound token that has only identity scopes (`caller.ts:62-64`).** RFC 6750 would call this 403 `insufficient_scope`. An MCP client receiving 401 will typically loop on re-auth. The effect is minor because only a member who unticked every MCP scope reaches this.

**L5. Test gaps (behaviour is correct by reading, but not proven):**
- Mixed MCP token refreshed with `scope=openid` → rejected at `/mcp`, accepted at userinfo.
- Disconnecting the app via `/oauth/connections` (consent revoked, not token revoke) → userinfo 401.
- Admin user on a mixed `openid articles:read` request still gets admin offered and unticked (regression guard for the `buildView` change).
- Unverified email → `email_verified: false`.
- Identity-only refresh with `resource=<origin>/mcp` → `invalid_target`.

## Edge Cases Found by Scout
- Refresh narrowing can produce a `/mcp`-bound, identity-only token. The `caller.ts:62` guard handles it. Untested (L5).
- `scope=openid admin` from a non-admin: `/mcp` audience, admin is filtered, so the token is `[openid]`. `/mcp` rejects it and userinfo accepts it. Correct.
- Omitted `scope` still defaults to member scopes with the `/mcp` audience. unlock.zuey.me must always send `scope=openid ...` explicitly, or it gets an MCP-scoped request.
- `recordConsent` replaces scopes per (user, client). A client that first gets MCP scopes and later runs an identity-only flow shows only `[openid...]` under connected apps, while its older MCP token family stays live. This semantics already existed and the PR did not introduce it; noted for awareness.
- CORS `*` on userinfo (machine endpoint) is fine because it is bearer-only and ignores cookies and query tokens. Userinfo is not in the edge HTML cache allowlist, and responses are `no-store`.
- `picture` passes through any user-set https URL. If the RP renders it directly, it can act as a tracking pixel. That is the RP's concern.

## Positive Observations (risk calibration)
- The guard is applied server-side in two layers (audience plus the scope check in caller), not only in consent UI.
- The existing PRM scope list and the default-scope path are unchanged, so the MCP client blast radius is small.

## Recommended Actions
1. (M1) Require `openid` on identity-only consent.
2. (M2) Add `client_id` to the userinfo response and document "only trust tokens you obtained yourself". Mirror this in unlock.zuey.me's callback: verify `token.scope` contains `openid` and, once added, that `client_id` matches.
3. (L2) Fix the email copy, or require `email_verified === true` in unlock before linking accounts.
4. (L5) Add the listed tests.
5. Optionally (L1/L3/L4).

## Metrics
- Type check: astro check 0 errors
- Tests: 2286 pass / 0 fail (full suite); new file 14 tests, 94 expects
- Lint: no lint script beyond astro check

## Verdict
**MERGE.** It meets the additive requirement and has no blocking security defect. M1 and M2 are cheap and should be done as a fast follow (M2 before any non-back-channel RP exists).

## Unresolved Questions
- Will unlock.zuey.me only ever consume tokens from its own server-side code exchange? If not, M2 becomes a blocker.
- Is the AS `scopes_supported` change (L1) acceptable under the "consent unchanged for existing clients" constraint?
