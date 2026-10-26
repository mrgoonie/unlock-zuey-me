# Hardening (small) report

- L1: `validateReturnTo` now also rejects a normalized pathname starting with `//` (`/.//evil.com` collapsed to `//evil.com` before). Tests added for all listed cases.
- L5: HSTS (`max-age=31536000; includeSubDomains`) is set wherever the CSP is set (HTML responses). `img-src` is now `'self' data: blob:`; no external image hosts exist in src (avatars are stored but never rendered; the client-metadata logo is a same-origin icon). Inline scripts unchanged.
- L6: `EvidenceImageUpload.tsx` uses a `peer sr-only` input plus label with `peer-focus-visible:ring`. Input keeps `data-testid="evidence-upload"`, so Playwright `setInputFiles` still works.
- L8: `deleteLearnerData` takes an optional OAuth helper and revokes all grants (paged `listUserGrants` + `revokeGrant`) for every owned learner id before the D1 batch; revocation failure aborts before D1 deletion so a retry completes. Route passes `getOAuthHelpers(env)` (lazy import). Result gains `grantsRevoked`.
- Certificates: `issueCertificate` rejects guests (after the eligibility check) with "Đăng nhập bằng zuey.me để nhận trang chứng nhận chia sẻ được". The achievements UI shows this prompt with a sign-in link to guests instead of the form. No e2e spec references certificates.

Verification: content:check, test (290 pass), build (0 errors). Playwright e2e not run (needs a deployed/preview target).

Unresolved: the review report file was not in this worktree, so its unresolved question 3 was not read; implemented from the task text.
