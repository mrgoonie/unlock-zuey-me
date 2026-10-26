// Shared constants of the ai-unlocked skill (CLI, Stop hook, uploader). Wire limits mirror
// src/lib/insights/ingest-contract.ts; tests/unit/skill-ingest-contract.test.ts fails CI if they drift.

export const SKILL_NAME = 'ai-unlocked';
/** Must equal manifest.json `version` (checked by tests/unit/skill-bundle-manifest.test.ts). */
export const SKILL_VERSION = '0.1.0';
export const MIN_NODE_MAJOR = 18;

export const DEFAULT_SERVER = 'https://unlock.zuey.me';
export const ADAPTER = 'claude-code';

/**
 * Every settings handler this package writes carries this marker in its `command`, so install can find and
 * replace its own entry and uninstall can remove only its own entries. `v<major>` changes only when the
 * handler shape changes; install replaces an older marker in place.
 */
export const HOOK_MARKER_PREFIX = '--ai-unlocked-hook=';
export const HOOK_MARKER_VERSION = 'v1';
export const HOOK_MARKER = `${HOOK_MARKER_PREFIX}${HOOK_MARKER_VERSION}`;
/**
 * `timeout` is in seconds for command hooks (default 600). 10 s is only a safety net: the hook finishes its
 * local work well under a second. Source: https://code.claude.com/docs/en/hooks ("timeout: Seconds before
 * canceling"; defaults 600 for command hooks).
 */
export const HOOK_TIMEOUT_SECONDS = 10;

/** Set on every process this package spawns; the hook exits at once when it sees it (no capture loops). */
export const INTERNAL_ENV = 'AI_UNLOCKED_INTERNAL';
export const TOKEN_ENV = 'AI_UNLOCKED_INGEST_TOKEN';
export const SERVER_ENV = 'AI_UNLOCKED_SERVER';

// Wire caps (src/lib/insights/ingest-contract.ts).
export const USER_PROMPT_MAX_CHARS = 4000;
export const ASSISTANT_FINAL_MAX_CHARS = 6000;
export const CLIENT_TARGET_BYTES = 16384;
export const TOOLS_MAX = 50;
export const MCP_TOOLS_MAX = 20;
export const REDACTION_KINDS_MAX = 32;
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MISSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{1,64}$/;
export const INGEST_TOKEN_PATTERN = /^aiu_ing_[A-Za-z0-9_-]{43}$/;

/** unlock.zuey.me MCP tools (src/lib/mcp/tools/*.ts). Only these feed `turn.platform`. */
export const PLATFORM_MCP_TOOLS = new Set([
  'get_profile', 'list_missions', 'get_mission', 'start_mission', 'get_run', 'submit_evidence', 'get_hint', 'abandon_mission',
]);

// Local spool and uploader limits.
export const SPOOL_MAX_FILES = 50;
export const SPOOL_MAX_BYTES = 1024 * 1024;
export const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const FLUSH_LOCK_STALE_MS = 60 * 1000;
export const POST_TIMEOUT_MS = 8000;
export const LOG_MAX_BYTES = 64 * 1024;
/** Back-off after `403 consent_required` or `404 feature_off` (docs/insights-ingest-contract.md). */
export const SERVER_BLOCK_MS = 24 * 60 * 60 * 1000;
