// Extracts the latest user prompt and the tools used after it from a Claude Code transcript (JSONL).
//
// The transcript line schema is not a documented contract, so this parser is defensive and pinned by fixtures
// (tests/fixtures/skill/transcripts). The documented floor is Stop's `last_assistant_message`, which the hook
// uses for the assistant text: "the transcript file isn't guaranteed to include the final message at Stop
// time" (https://code.claude.com/docs/en/hooks, "Stop input"). Any parse problem yields `{userPrompt: null, tools: []}`.
//
// Observed shape (Claude Code 2.1.x): one JSON object per line; `type: "user" | "assistant" | ...`;
// `message.content` is a string or an array of parts (`text`, `tool_use {id,name,input}`, `tool_result
// {tool_use_id,is_error}`, `thinking`); meta lines carry `isMeta`, subagent lines `isSidechain`, compaction
// summaries `isCompactSummary`.
import fs from 'node:fs';
import { MISSION_ID_PATTERN, PLATFORM_MCP_TOOLS, RUN_ID_PATTERN, TOOLS_MAX, TOOL_NAME_PATTERN, MCP_TOOLS_MAX } from './constants.mjs';

/** Bytes read from the end of the transcript. */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** User lines that Claude Code itself injects into the conversation (not typed by the learner). */
const INJECTED_PREFIXES = ['<task-notification>', '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>', '<system-reminder>'];

/**
 * @typedef {{ name: string, ok: boolean, count: number }} ToolUse
 * @typedef {{ mcpTools: string[], missionId?: string, runId?: string }} PlatformInfo
 * @typedef {{ userPrompt: string | null, tools: ToolUse[], platform: PlatformInfo | null, parsed: boolean }} TranscriptWindow
 */

/** @returns {TranscriptWindow} */
const EMPTY = () => ({ userPrompt: null, tools: [], platform: null, parsed: false });

/**
 * Last `maxBytes` of a regular file as UTF-8 lines (a partial first line is dropped). Null when unreadable.
 * @param {string} file
 */
export function readTailLines(file, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const length = Math.min(st.size, maxBytes);
    const start = st.size - length;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const lines = buf.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/** The learner's prompt text of a user line, or null when the line is not a typed prompt. */
function promptText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return null;
  const message = entry.message;
  if (!message || typeof message !== 'object' || (message.role !== undefined && message.role !== 'user')) return null;
  const { content } = message;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((p) => p && p.type === 'tool_result')) return null;
    const parts = content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
    if (parts.length) text = parts.join('\n');
  }
  if (text === null) return null;
  const trimmed = text.trimStart();
  if (trimmed === '' || INJECTED_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
  return text;
}

/** `mcp__<server>__<tool>` of an unlock.zuey.me server → the bare tool name, else null. */
function platformTool(name) {
  const m = /^mcp__(.+)__([a-z0-9_]{1,64})$/.exec(name);
  return m && /unlock/i.test(m[1]) && PLATFORM_MCP_TOOLS.has(m[2]) ? m[2] : null;
}

/**
 * Parses the window between the latest learner prompt and the end of the transcript.
 * @param {string[]} lines
 * @returns {TranscriptWindow}
 */
export function parseTranscriptLines(lines) {
  /** @type {Array<{ id: unknown, name: string, input: any }>} */
  const toolUses = [];
  /** @type {Set<unknown>} */
  const erroredIds = new Set();
  let prompt = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn or partial line; the rest of the window is still usable
    }
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : null;
    if (entry.type === 'assistant' && content) {
      // Lines are walked newest-first, so parts are pushed last-first too; one reverse() restores order.
      for (let p = content.length - 1; p >= 0; p--) {
        const part = content[p];
        if (part && part.type === 'tool_use' && typeof part.name === 'string') toolUses.push({ id: part.id, name: part.name, input: part.input });
      }
      continue;
    }
    if (entry.type === 'user') {
      if (content) for (const part of content) if (part && part.type === 'tool_result' && part.is_error === true) erroredIds.add(part.tool_use_id);
      prompt = promptText(entry);
      if (prompt !== null) break;
    }
  }
  if (prompt === null) return EMPTY();

  toolUses.reverse(); // chronological
  /** @type {Map<string, ToolUse>} */
  const byName = new Map();
  /** @type {string[]} */
  const mcpTools = [];
  let missionId;
  let runId;
  for (const use of toolUses) {
    if (!TOOL_NAME_PATTERN.test(use.name)) continue;
    const ok = !erroredIds.has(use.id);
    const known = byName.get(use.name);
    if (known) {
      known.count = Math.min(known.count + 1, 1000);
      known.ok = known.ok && ok;
    } else if (byName.size < TOOLS_MAX) {
      byName.set(use.name, { name: use.name, ok, count: 1 });
    }
    const bare = platformTool(use.name);
    if (!bare) continue;
    if (!mcpTools.includes(bare) && mcpTools.length < MCP_TOOLS_MAX) mcpTools.push(bare);
    const input = use.input && typeof use.input === 'object' ? use.input : {};
    if (typeof input.mission_id === 'string' && MISSION_ID_PATTERN.test(input.mission_id)) missionId = input.mission_id;
    if (typeof input.run_id === 'string' && RUN_ID_PATTERN.test(input.run_id)) runId = input.run_id;
  }
  /** @type {PlatformInfo | null} */
  let platform = null;
  if (mcpTools.length) {
    platform = { mcpTools };
    if (missionId) platform.missionId = missionId;
    if (runId) platform.runId = runId;
  }
  return { userPrompt: prompt, tools: [...byName.values()], platform, parsed: true };
}

/**
 * Reads the transcript tail and parses it. Never throws.
 * @param {unknown} transcriptPath
 * @returns {TranscriptWindow}
 */
export function readTranscriptWindow(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return EMPTY();
  try {
    const lines = readTailLines(transcriptPath);
    return lines ? parseTranscriptLines(lines) : EMPTY();
  } catch {
    return EMPTY();
  }
}
