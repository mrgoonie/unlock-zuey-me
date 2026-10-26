# zuey-me: Sign in with zuey.me (identity scopes + userinfo)

- Issue: https://github.com/mrgoonie/zuey-me/issues/381 (label `in review`)
- PR: https://github.com/mrgoonie/zuey-me/pull/382 (branch `feat/oauth-identity-userinfo`, chưa merge)
- Worktree: /Volumes/GOON/www/zuey/zuey-me-wt-oauth-identity (giữ lại)

## Đã làm
- Scope `openid`, `profile`, `email` trong `OAUTH_SCOPES` + AS metadata; `isMemberScope` loại trừ chúng nên không vào `can()`.
- `GET`/`POST /oauth/userinfo`: Bearer header, nhận mọi token còn hiệu lực có `openid`; claims lọc theo scope; 401 `invalid_token` / 403 `insufficient_scope`; `Cache-Control: no-store`; `userinfo_endpoint` trong metadata; thêm vào machine endpoints.
- Request chỉ có identity scope -> audience `<issuer>/oauth/userinfo` (bỏ `resource` hoặc gửi đúng URI đó). `/mcp` từ chối theo audience, và thêm check: token `/mcp` không có scope MCP nào -> 401. `/api/mcp` + REST vốn không nhận `zoa_` (có test).
- Consent: copy tiếng Việt; sign-in request không bao giờ offer `admin`.
- CIMD unlock + DCR loopback `http://localhost:4321/auth/zuey/callback`: chạy sẵn, không cần sửa code, đã có test.
- README + OpenAPI cập nhật. Không có migration.

## Kết quả
- `bun test`: 2286 pass, 0 fail (thêm 14 test trong `tests/oauth-identity-userinfo.test.ts`).
- `bun run build`: 0 errors, 0 warnings.

## Contract notes (cho unlock)
- Gửi `scope=openid profile email`, có thể bỏ `resource`. Nếu gửi `resource`, phải là `https://zuey.me/oauth/userinfo`; gửi `/mcp` cùng identity-only scope sẽ bị `invalid_target`.
- Không có `id_token`/JWKS: unlock phải gọi userinfo để lấy `sub`/email.
- Access token TTL 30 ngày, refresh 90 ngày (xoay vòng); userinfo trả 401 ngay khi member ngắt kết nối app.

## Câu hỏi chưa giải quyết
- Không có.

## Follow-up review (commit 6e4aabb)
- M1: `openid` bắt buộc khi request có nó (checkbox disabled + server tự thêm); `profile`/`email` thiếu `openid` -> `invalid_scope`.
- L2: copy email: "Xem địa chỉ email của bạn (và email đã được xác minh hay chưa)".
- L4: token `/mcp` chỉ có identity scope -> 403 `insufficient_scope`.
- `bun test` 2287 pass / 0 fail; build 0 errors / 0 warnings.
