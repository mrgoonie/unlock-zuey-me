# Research: MCP 2026-07-28 + Cloudflare Workers stack cho unlock.zuey.me

Ngày: 2026-10-26 (Asia/Saigon). Nguồn đã kiểm tra: raw spec trên GitHub (`modelcontextprotocol/modelcontextprotocol@main`), `.d.ts` và README trong các npm tarball (`npm pack`), `npm view`, OpenRouter `/api/v1/models` (live), Cloudflare docs, Astro docs. Những gì chưa xác minh được đánh dấu **[UNVERIFIED]**.

## TL;DR (khuyến nghị đã xếp hạng)

1. **MCP SDK:** dùng `@modelcontextprotocol/server@2.4.0` (SDK v2, có `createMcpHandler` chuẩn Web fetch). **Không** dùng `@modelcontextprotocol/sdk@1.32.2`, vì bản v1 chỉ hỗ trợ tới `2025-11-25`.
2. **Auth:** dùng `@cloudflare/workers-oauth-provider@1.2.4` với class `OAuthProvider` (một Worker kiêm cả AS và RS). Gói này hỗ trợ CIMD, DCR, RFC 8707, RFC 9728 và RFC 9207. Bật cả CIMD lẫn DCR.
3. **Dual-era:** giữ mặc định `legacy: 'stateless'` để client 2025-06-18/2025-11-25 vẫn chạy được, vì client hiện tại chưa chắc đã nói 2026-07-28.
4. **Web app:** dùng Astro **7** (`astro@7.4.2`, không phải 5/6) với `@astrojs/cloudflare@14.4.2`. Đặt custom entry `src/worker.ts` qua `"main"` trong wrangler; `OAuthProvider` là lớp ngoài cùng, Astro `handle` làm `defaultHandler`.
5. **Web Push:** dùng `@block65/webcrypto-web-push@2.0.0` (aes128gcm + VAPID theo RFC 8291/8292, Apple chấp nhận).
6. **LLM:** chọn coach = `google/gemini-3.1-flash-lite` hoặc `anthropic/claude-haiku-5.5`, grading = `anthropic/claude-sonnet-5.5`. Fallback = Workers AI `@cf/aisingapore/gemma-sea-lion-v4-27b-it`.

## Versions đã xác minh (npm, 2026-10-26)

| Package | Version | Ghi chú |
|---|---|---|
| `@modelcontextprotocol/server` | 2.4.0 | v2, spec 2026-07-28, peer `zod ^4.2.0`, tự shim workerd |
| `@modelcontextprotocol/sdk` | 1.32.2 | v1, `LATEST_PROTOCOL_VERSION='2025-11-25'`: **không có 2026-07-28** |
| `@cloudflare/workers-oauth-provider` | 1.2.4 | README ghi rõ chuẩn "MCP authorization 2026-07-28" |
| `agents` | 0.30.1 | `agents/mcp/server` `createMcpHandler`; peer **pin cứng** `@modelcontextprotocol/server: 2.3.1` |
| `astro` | 7.4.2 | |
| `@astrojs/cloudflare` | 14.4.2 | peer `astro ^7.4.0`, `wrangler ^4.125.0`, dùng `@cloudflare/vite-plugin` |
| `wrangler` | 4.152.0 | |
| `@block65/webcrypto-web-push` | 2.0.0 | ~457k lượt tải/tháng, ra 2026-09-03 |
| `@pushforge/builder` | 2.0.5 | ~322k lượt tải/tháng, zero-dep (phương án thay thế) |

---

## 1. MCP 2026-07-28: Streamable HTTP

Nguồn: `docs/specification/2026-07-28/basic/transports/streamable-http.mdx`, `changelog.mdx`, `basic/versioning.mdx`, MCP blog.

**Quy tắc request/response (modern):**
- Có một endpoint duy nhất (ví dụ `/mcp`), **chỉ POST**. **GET stream đã bị xóa** và DELETE cũng không còn. Server chỉ hỗ trợ bản này thì **SHOULD** trả `405` cho GET/DELETE.
- **Sessions đã bị xóa**: không còn `Mcp-Session-Id`. Nếu client cũ gửi header này thì bỏ qua, không mint và không echo. `Last-Event-ID` cũng bỏ qua vì stream không còn resumable.
- Mỗi JSON-RPC message là một POST riêng. Body phải là một request hoặc notification đơn lẻ (không batch, không response).
- Header **bắt buộc** trên mọi POST:
  - `Accept: application/json, text/event-stream`
  - `MCP-Protocol-Version: 2026-07-28`, phải khớp `params._meta["io.modelcontextprotocol/protocolVersion"]`
  - `Mcp-Method: <method>` cho mọi request
  - `Mcp-Name: <params.name|params.uri>` cho `tools/call`, `resources/read`, `prompts/get` (giá trị không phải ASCII thì dùng Base64 sentinel)
  - `Authorization: Bearer …` trên **mọi** request
- Server trả `application/json` (một object) hoặc `text/event-stream`. SSE chỉ được chứa notification liên quan tới request đó rồi kết thúc bằng response, và server **không** được gửi request lên stream. Notification thì trả `202` không có body.
- Mã lỗi:
  - `400` + `-32020 HeaderMismatch`: header thiếu, sai hoặc không khớp body
  - `400` + `-32022 UnsupportedProtocolVersion` (liệt kê `supported`)
  - `404` + `-32601`: method không tồn tại
  - `-32021 MissingRequiredClientCapability`
  - Resource not found đổi sang `-32602`
- Origin không hợp lệ thì trả `403`. Khi mở SSE nên thêm `X-Accel-Buffering: no` và keep-alive `:\r\n`.

**Handshake:**
- `initialize` và `notifications/initialized` **đã bị xóa**. Mỗi request mang theo `_meta` gồm:
  - `io.modelcontextprotocol/protocolVersion`
  - `io.modelcontextprotocol/clientCapabilities`
  - `io.modelcontextprotocol/clientInfo` (SHOULD)
- Server **MUST** implement `server/discover` (trả versions, capabilities, serverInfo). Mọi result có `resultType` (`"complete"` | `"input_required"`) và `_meta["io.modelcontextprotocol/serverInfo"]`.
- `ping` và `logging/setLevel` đã bị xóa. Sampling/elicitation/roots chuyển sang **MRTR**: server trả `InputRequiredResult`, client retry kèm `inputResponses`. Roots/Sampling/Logging bị deprecated.
- Các list result phải có `ttlMs` + `cacheScope`. Thông báo list thay đổi đi qua POST `subscriptions/listen` (SSE dài hạn). SDK v2 lo phần này.
- Muốn giữ state thì dùng handle do server mint rồi truyền lại qua tool arguments.

**Backward compat:**
- Server dual-era: request có `_meta` envelope thì xử lý modern stateless. Request `initialize` thì xử lý legacy (session theo bản 2025). Có thể phục vụ cả hai trên cùng endpoint.
- Server có thể coi request thiếu `MCP-Protocol-Version` là `2025-03-26` nếu muốn hỗ trợ client trước 2025-06-18.
- Client dual-era thử modern trước. Gặp `400` không kèm modern error body thì fallback sang `initialize`. Client legacy gặp server modern-only thì **fail** vì không có cơ chế fall-forward. Server modern-only **SHOULD** ghi các version được hỗ trợ trong lỗi trả về cho `initialize`.
- Client hiện tại (Claude.ai, Claude Code, ChatGPT): **[UNVERIFIED]**. Blog spec và search không nói client nào đã nói 2026-07-28. Nên **bắt buộc dual-era**: `createMcpHandler` mặc định `legacy: 'stateless'` phục vụ 2025-era bằng một instance mới cho mỗi request (GET/DELETE trả 405). Session sẽ không được giữ, nhưng client 2025 hầu hết vẫn chạy được vì stateless là idiom hợp lệ từ 2025.

**Authorization 2026-07-28** (`basic/authorization/index.mdx`, `client-registration.mdx`):
- RS **MUST** implement PRM (RFC 9728). AS phải có RFC 8414 hoặc OIDC discovery, và OAuth 2.1 + PKCE.
- Thứ tự client registration: pre-registered → **CIMD** (`client_id_metadata_document_supported`) → DCR. **DCR đã bị deprecated** nhưng vẫn giữ để tương thích.
- Client **MUST** gửi `resource` (RFC 8707) ở cả authorize lẫn token request. RS **MUST** kiểm tra audience.
- AS SHOULD trả `iss` (RFC 9207) và quảng bá `authorization_response_iss_parameter_supported`. DCR client phải gửi `application_type`.
- 401 kèm `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. 403 `insufficient_scope` dùng cho step-up. RS SHOULD NOT đưa `offline_access` vào PRM.

## 2. Stateless MCP + OAuth 2.1 trên Workers

### 2a. `@cloudflare/workers-oauth-provider@1.2.4` (đã kiểm tra `.d.ts`)

Các option chính của `new OAuthProvider<Env>({...})`:

| Option | Ý nghĩa |
|---|---|
| `apiRoute` + `apiHandler` (hoặc `apiHandlers`) | route được bảo vệ. Handler nhận `ctx.props` (từ `completeAuthorization`) và `ctx.auth` `{token, audience, scope[], expiresAt?, userId?, clientId?}` |
| `defaultHandler` (bắt buộc) | mọi request khác, kể cả trang `/authorize`. `env.OAUTH_PROVIDER` được inject vào env truyền cho handler |
| `authorizeEndpoint`, `tokenEndpoint` (bắt buộc) | ví dụ `'/authorize'`, `'/oauth/token'` |
| `clientRegistrationEndpoint` | bật DCR (RFC 7591), mặc định tắt |
| `clientIdMetadataDocumentEnabled: true` | bật **CIMD**. **Bắt buộc** compat flag `global_fetch_strictly_public` |
| `resourceMetadata` (**bắt buộc** từ 1.x) | `{ resource, authorization_servers?, bearer_methods_supported?, resource_name? }`. PRM được phục vụ tại `/.well-known/oauth-protected-resource/mcp` |
| `scopesSupported`, `requiredScopes` | `requiredScopes` chỉ được quảng bá trên PRM và 401, **không được enforce**: handler tự kiểm tra `ctx.auth.scope` hoặc dùng `insufficientScope()` |
| `accessTokenTTL`, `refreshTokenTTL`, `refreshTokenIdleTTL`, `allowPrivateUseRedirectUris`, `cookiePrefix`, `onError` | |

- Storage: KV binding tên **`OAUTH_KV`**.
- RFC 8707: token bị bind vào `resource` và RS từ chối token cấp cho audience khác. Đường dẫn con dưới canonical path vẫn được chấp nhận.
- Helpers trong `OAuthHelpers`: `parseAuthRequest(req)`, `lookupClient(id)`, `describeConsent(authReq)`, `completeAuthorization({ request, userId, metadata, scope, props, revokeExistingGrants? }) → { redirectTo }`.
- Bên ngoài fetch dispatch thì dùng `getOAuthApi(options, env)`. Cron dùng `provider.purgeExpiredData(env)`.
- Docs của gói có ghi CIMD của ChatGPT dùng `none`/`private_key_jwt` và gói đã xử lý trường hợp này.

### 2b. MCP SDK: chọn gì

| Tiêu chí | **#1 `@modelcontextprotocol/server` 2.4.0 trực tiếp** | #2 `agents/mcp/server` (0.30.1) |
|---|---|---|
| Spec 2026-07-28 + dual-era | Có (`createMcpHandler`, `legacy: 'stateless'\|'reject'`) | Có (bọc SDK v2) |
| Lấy auth từ OAuthProvider | ~6 dòng glue (`ctx.auth` → `authInfo`) | Tự động (đọc verified context, `getMcpAuthContext()`) |
| Origin/Host/CORS | Tự gọi `originValidationResponse` | Có sẵn mặc định |
| Rủi ro phụ thuộc | Thấp | Peer **pin `@modelcontextprotocol/server@2.3.1`** nên xung đột với 2.4.0. Gói lớn, release dày |
| Durable Objects | Không cần | Không cần (`McpAgent` đã **deprecated / feature-frozen**) |

Chọn **#1**. Lý do: ít dependency nhất, dùng SDK mới nhất, phần glue rất nhỏ. Chọn #2 khi muốn dùng thêm các thứ khác của `agents` và chấp nhận pin `@modelcontextprotocol/server@2.3.1`.

API v2 (đã kiểm tra `.d.ts`):
- `createMcpHandler(factory, opts?) → { fetch(req, {authInfo?}), close, notify, bus }`. Factory được gọi **mỗi request** với `{ era, authInfo?, requestInfo? }`.
- `opts`: `legacy`, `responseMode: 'auto'|'sse'|'json'`, `keepAliveMs` (mặc định 15000), `maxRequestBodySize` (mặc định 4 MiB).
- `McpServer.registerTool(name, { title, description, inputSchema: z.object(...), outputSchema?, annotations? }, cb)`.
- Kiểu `AuthInfo` = `{ token, clientId, scopes, expiresAt?, resource?: URL, extra? }`.
- Entry **không** verify token, nên bắt buộc phải đặt sau OAuthProvider.

Snippet `src/mcp/server.ts`:

```ts
import { McpServer, createMcpHandler, originValidationResponse } from '@modelcontextprotocol/server';
import type { OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { env } from 'cloudflare:workers';
import { z } from 'zod';

type Props = { userId: string; email: string };

const mcp = createMcpHandler(({ authInfo }) => {
  const props = authInfo?.extra as Props; // per-request instance → closures are safe
  const server = new McpServer({ name: 'unlock-zuey', version: '1.0.0' });
  server.registerTool('get_progress', {
    description: 'Tiến độ học của người dùng hiện tại',
    inputSchema: z.object({ courseId: z.string() }),
    annotations: { readOnlyHint: true },
  }, async ({ courseId }) => {
    const row = await env.DB.prepare('SELECT * FROM progress WHERE user_id=? AND course_id=?')
      .bind(props.userId, courseId).first();
    return { content: [{ type: 'text', text: JSON.stringify(row ?? {}) }], structuredContent: row ?? {} };
  });
  return server;
}); // default legacy:'stateless' → serves 2025-06-18/2025-11-25 clients too

export const McpApiHandler = {
  async fetch(req: Request, _env: Env, ctx: OAuthResourceContext<Props>) {
    // [UNVERIFIED] assumes requests without Origin (non-browser clients) pass
    const bad = originValidationResponse(req, ['unlock.zuey.me', 'claude.ai', 'chatgpt.com']);
    if (bad) return bad;
    const a = ctx.auth;
    return mcp.fetch(req, { authInfo: {
      token: a.token, clientId: a.clientId ?? '', scopes: a.scope,
      expiresAt: a.expiresAt, resource: new URL(a.audience), extra: ctx.props,
    }});
  },
};
```

Biến thể #2 (theo Cloudflare docs): `import { createMcpHandler } from 'agents/mcp/server'`, rồi `apiHandler: { fetch: (r, e, c) => createMcpHandler(factory)(r, e, c) }`. Props được lấy tự động và đọc bằng `getMcpAuthContext()?.props`.

## 3. Astro 7 trên Workers (static assets, không dùng Pages)

- Cài bằng `npx astro add cloudflare`. Config `astro.config.mjs`: `import cloudflare from '@astrojs/cloudflare'; export default defineConfig({ output: 'server', adapter: cloudflare() })`. Thêm `prerender = true` cho các trang tĩnh.
- Adapter tự set `main` mặc định `@astrojs/cloudflare/entrypoints/server`, assets binding `ASSETS`, và auto-provision KV `SESSION` cho Astro sessions. Muốn đổi tên binding thì dùng option `sessionKVBindingName`. Không cần khai báo `assets.directory` vì vite plugin tự tính.
- **`Astro.locals.runtime` đã bị xóa.** Bindings và secrets đọc qua `import { env } from 'cloudflare:workers'` ở mọi nơi (page, API route, middleware). `ExecutionContext` lấy qua `Astro.locals.cfContext` / `context.locals.cfContext` (ví dụ `.waitUntil()`). `astro:env/server` vẫn dùng được.

```ts
// src/pages/api/streak.ts
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
export const GET: APIRoute = async ({ locals }) => {
  const n = await env.KV.get('streak:x');
  locals.cfContext.waitUntil(env.DB.prepare('UPDATE …').run());
  return Response.json({ n });
};
```

**Custom entrypoint.** Đặt `"main": "./src/worker.ts"` trong wrangler, import `handle` từ `@astrojs/cloudflare/handler` (signature `(request, env, ctx)`). OAuthProvider bọc ngoài Astro, và `scheduled` được export cùng chỗ:

```ts
// src/worker.ts
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handle } from '@astrojs/cloudflare/handler';
import { McpApiHandler } from './mcp/server';
import { runDailyJobs } from './jobs/daily';

export const oauthOptions = {
  apiRoute: '/mcp',
  apiHandler: McpApiHandler,
  defaultHandler: { fetch: handle },          // Astro renders /authorize, UI, API
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register', // DCR (deprecated but needed for older clients)
  clientIdMetadataDocumentEnabled: true,          // CIMD
  scopesSupported: ['learn:read', 'learn:write', 'offline_access'],
  requiredScopes: ['learn:read'],
  resourceMetadata: { resource: 'https://unlock.zuey.me/mcp', authorization_servers: ['https://unlock.zuey.me'], resource_name: 'Unlock Zuey' },
} satisfies ConstructorParameters<typeof OAuthProvider<Env>>[0];

const provider = new OAuthProvider<Env>(oauthOptions);

export default {
  fetch: (req, env, ctx) => provider.fetch(req, env, ctx),
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(Promise.all([runDailyJobs(controller.cron, env), provider.purgeExpiredData(env)]));
  },
} satisfies ExportedHandler<Env>;
```

Ở trang `/authorize` trong Astro, gọi `getOAuthApi(oauthOptions, env)` (env lấy từ `cloudflare:workers`) thay vì `env.OAUTH_PROVIDER`. Lý do: provider gắn `OAUTH_PROVIDER` vào object env truyền cho `defaultHandler`, và **[UNVERIFIED]** object đó có thể không trùng với env của `cloudflare:workers`. Flow trên trang: `parseAuthRequest`, rồi `describeConsent`, rồi đăng nhập và đồng ý, rồi `completeAuthorization({ request, userId, metadata:{}, scope, props:{userId,email} })`, cuối cùng redirect tới `redirectTo`. Cần tránh import vòng giữa `worker.ts` và các page: tách `oauthOptions` ra một module riêng.

`wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "unlock-zuey-me",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-10-20",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "binding": "ASSETS" },
  "routes": [{ "pattern": "unlock.zuey.me", "custom_domain": true }],
  "workers_dev": false,
  "d1_databases": [{ "binding": "DB", "database_name": "unlock-zuey", "database_id": "<id>", "migrations_dir": "migrations" }],
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "<id>" },
    { "binding": "KV", "id": "<id>" },
    { "binding": "SESSION", "id": "<id>" }
  ],
  "r2_buckets": [{ "binding": "R2", "bucket_name": "unlock-zuey" }],
  "ai": { "binding": "AI" },
  "triggers": { "crons": ["0 0 * * *", "*/15 * * * *"] },  // UTC: 00:00 UTC = 07:00 ICT
  "observability": { "enabled": true }
  // secrets: wrangler secret put OPENROUTER_API_KEY / VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY / VAPID_SUBJECT
}
```

Chạy `wrangler types` để sinh `Env`. Cron luôn chạy theo UTC.

## 4. Web Push từ Worker

Chọn **`@block65/webcrypto-web-push@2.0.0`**. Gói chỉ dùng WebCrypto, mã hóa aes128gcm (RFC 8291) và VAPID scheme `vapid` (RFC 8292), pad cố định 4096 B (payload tối đa 3993 B). Bản 1.x dùng `aesgcm` nên **Apple từ chối**, vì vậy bắt buộc dùng 2.x. Phương án thay thế: `@pushforge/builder@2.0.5` (zero-dep, có CLI `npx @pushforge/builder vapid`, đã chạy được trên Workers).

```ts
import { buildPushPayload, type PushSubscription } from '@block65/webcrypto-web-push';
const vapid = { subject: env.VAPID_SUBJECT /* mailto:… */, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
const payload = await buildPushPayload({ data: JSON.stringify({ title, body, url }), options: { ttl: 3600, urgency: 'normal' } }, sub as PushSubscription, vapid);
const res = await fetch(sub.endpoint, payload);
if (res.status === 404 || res.status === 410) await deleteSubscription(sub.endpoint); // expired
```

- Key là base64url theo định dạng của `web-push generate-vapid-keys`. **[UNVERIFIED]** chưa chạy thử round-trip key.
- Trong `PushMessage.options`, field `urgency` cần kiểm lại trong `types.d.ts` khi code.

Yêu cầu push trên iOS:
- iOS/iPadOS **16.4+**, và web app phải được **Add to Home Screen**. Safari tab thường không nhận push.
- Manifest cần `display: standalone` (hoặc `fullscreen`).
- Phải gọi `Notification.requestPermission()` từ một user gesture.
- Cần service worker có handler `push` và mỗi push phải hiển thị notification (không cho silent push).
- iOS 18.4+ có thêm **Declarative Web Push**: payload JSON có `web_push: 8030`, không cần SW, vẫn tương thích ngược. Muốn dùng thì có thể gửi payload ở định dạng declarative.
- EU: đã có lúc hạn chế home-screen web apps. **[UNVERIFIED]** chưa rõ hiện trạng.

## 5. OpenRouter

- Endpoint: `POST https://openrouter.ai/api/v1/chat/completions` (tương thích OpenAI), header `Authorization: Bearer $OPENROUTER_API_KEY`. Nên thêm `HTTP-Referer: https://unlock.zuey.me` và `X-Title`. Gọi bằng `fetch` là đủ; nếu muốn có SDK thì `@openrouter/sdk@1.5.7`.
- Structured output:

```json
{ "model": "anthropic/claude-sonnet-5.5", "messages": [...],
  "response_format": { "type": "json_schema", "json_schema": { "name": "grade", "strict": true,
    "schema": { "type": "object", "properties": { "score": {"type":"integer"}, "feedback": {"type":"string"} },
                "required": ["score","feedback"], "additionalProperties": false } } },
  "provider": { "require_parameters": true } }
```

`require_parameters: true` buộc OpenRouter chỉ route tới endpoint hỗ trợ `response_format`. Với request non-streaming, có thể bật plugin Response Healing.

- Usage: `GET https://openrouter.ai/api/v1/key`, response nằm trong `{ data: {...} }`:
  - Credit: `label`, `limit`, `limit_remaining`, `limit_reset`, `include_byok_in_limit`
  - Usage: `usage`, `usage_daily`, `usage_weekly`, `usage_monthly` (+ các biến thể `byok_*`)
  - Budget: `budgets[]`, `effective_budget`
  - Khác: `is_free_tier`, `free_model_daily_requests{used,limit,remaining}`
  - `rate_limit` đã deprecated

Model lấy từ `/api/v1/models` (live). Cả hai cột đều có `response_format` + `structured_outputs`. Giá tính bằng USD/Mtok (in/out).

| Vai trò | Slug | Giá in / out | Ghi chú |
|---|---|---|---|
| Coach #1 | `google/gemini-3.1-flash-lite` | 0.25 / 1.50 | Gemini mạnh đa ngôn ngữ |
| Coach #2 | `anthropic/claude-haiku-5.5` | 0.10 / 0.50 | rẻ nhất trong nhóm lớn, có `:batch` 0.05/0.25 |
| Coach rẻ nhất | `deepseek/deepseek-v4-flash` | 0.091 / 0.182 | tiếng Việt cần thử |
| Grading #1 | `anthropic/claude-sonnet-5.5` | 2.00 / 10.00 | reasoning |
| Grading rẻ | `deepseek/deepseek-v4-pro` | 0.955 / 1.911 | reasoning |
| Grading alt | `openai/gpt-6.1-sol` | 2.00 / 10.00 | |

Chất lượng tiếng Việt: **[UNVERIFIED]**, chưa benchmark. Nên eval nhanh trên 20 prompt thật trước khi chốt. Giá có thể thay đổi; luôn đọc giá từ API.

## 6. Workers AI: fallback tiếng Việt

- **#1 `@cf/aisingapore/gemma-sea-lion-v4-27b-it`**: tune cho Đông Nam Á, context 128k, giá $0.351 in / $0.555 out mỗi Mtok. Docs không liệt kê ngôn ngữ cụ thể. Họ SEA-LION có tiếng Việt, nhưng điều này lấy từ kiến thức chung **[UNVERIFIED trên trang CF]**.
- **#2 `@cf/qwen/qwen3-30b-a3b-fp8`**: docs ghi "multilingual".

```ts
const r = await env.AI.run('@cf/aisingapore/gemma-sea-lion-v4-27b-it', { messages: [{ role: 'system', content: '…' }, { role: 'user', content: '…' }] });
```

## Adoption risk

- **SDK v2 / spec 2026-07-28:** rất mới (spec ra 3 tháng trước). SDK v2 ra bản minor nhanh (2.2 → 2.4), nên pin chính xác version. Ghi chú ở mục 2b về peer pin của `agents` cũng là một rủi ro.
- **workers-oauth-provider 1.x:** do Cloudflare duy trì, API 1.x đã ổn định. Bản 1.x đổi `resourceMetadata` thành bắt buộc (có `docs/migration-1.x.md`).
- **Astro 7 + adapter 14:** gần đây có breaking change (đã xóa `locals.runtime`, chuyển sang vite plugin), nên pin version.
- **block65 2.0.0:** một maintainer, tần suất release thấp. Pushforge là phương án dự phòng.

## Giới hạn của research này

- Không chạy code thật trên workerd (không có deploy, không có `wrangler dev`). Các snippet được dựng từ typings/README, chưa compile.
- Không xác minh được client Claude/ChatGPT đang dùng protocol version nào. Thiết kế dual-era để giảm rủi ro này.
- Không đọc docs con của workers-oauth-provider về consent page và upstream sign-in một cách chi tiết.

## Unresolved questions

1. Claude.ai / Claude Code / ChatGPT connectors hiện gửi `MCP-Protocol-Version` nào, và có dùng CIMD không? (Cần test bằng log thật sau khi deploy.)
2. `originValidationResponse` có cho qua request không có header `Origin` không? Cần test hoặc đọc source trước khi bật.
3. `env.OAUTH_PROVIDER` có thấy được qua `cloudflare:workers` env bên trong Astro không? Đang khuyến nghị `getOAuthApi()` để né vấn đề này.
4. Login người dùng (upstream IdP: zuey.me SSO, Google, hay magic link) chưa được quyết định. Lựa chọn này ảnh hưởng tới trang `/authorize` và `props`.
5. Chưa benchmark chất lượng tiếng Việt cho các model OpenRouter/Workers AI đã chọn.

Status: DONE_WITH_CONCERNS
Summary: Đã xác minh version và API từ tarball/spec/live API. Stack đề xuất: MCP SDK v2 `createMcpHandler` (dual-era), workers-oauth-provider 1.2.4 (CIMD + DCR + RFC 8707), Astro 7 với custom `src/worker.ts`, block65 web-push 2.0.0. Concerns: chưa rõ client hiện tại hỗ trợ protocol version nào, snippet chưa compile, chất lượng tiếng Việt của model chưa benchmark.
