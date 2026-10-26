/**
 * /mcp OAuth scopes and resource identifiers. `learn:write` implies `learn:read` (MCP asks servers to honour
 * their own scope hierarchy). Shared by the OAuth options, the consent page and the tools.
 */
export const LEARN_READ = 'learn:read';
export const LEARN_WRITE = 'learn:write';
export const MCP_SCOPES = [LEARN_READ, LEARN_WRITE] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_SITE = 'https://unlock.zuey.me';
export const MCP_RESOURCE = `${MCP_SITE}/mcp`;
export const MCP_RESOURCE_METADATA_URL = `${MCP_SITE}/.well-known/oauth-protected-resource/mcp`;

/** Plain-Vietnamese descriptions shown on the consent page. */
export const SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
  [LEARN_READ]: 'Xem hồ sơ học, danh sách nhiệm vụ, bài đang làm và tiến độ của bạn',
  [LEARN_WRITE]: 'Bắt đầu nhiệm vụ, xin gợi ý và nộp bài làm thay bạn',
};

export const isMcpScope = (s: string): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s);

export const canRead = (scopes: readonly string[]) => scopes.includes(LEARN_READ) || scopes.includes(LEARN_WRITE);
export const canWrite = (scopes: readonly string[]) => scopes.includes(LEARN_WRITE);

/** Scopes to offer on the consent page: the requested known scopes, or all of them when none were asked. */
export function consentScopes(requested: readonly string[]): McpScope[] {
  const known = MCP_SCOPES.filter((s) => requested.includes(s));
  return known.length ? known : [...MCP_SCOPES];
}
