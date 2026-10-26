/**
 * Client/server drift guard: payloads built by the skill (turn-payload.mjs) must satisfy the server's strict
 * ingestTurnV1Schema, and the skill's copies of the wire caps must equal the contract constants.
 */
import { describe, expect, it } from 'vitest';
import * as contract from '../../src/lib/insights/ingest-contract';
import * as skill from '../../skills/ai-unlocked/scripts/lib/constants.mjs';
import { buildTurnPayload, idempotencyKeyFor, sha256Hex } from '../../skills/ai-unlocked/scripts/lib/turn-payload.mjs';
import { readTranscriptWindow } from '../../skills/ai-unlocked/scripts/lib/transcript-window.mjs';
import { fixture } from '../fixtures/skill/skill-test-helpers';

const SALT = 'a'.repeat(64);
const NOW = new Date('2026-10-26T16:00:00.000Z');
const input = (patch: Record<string, unknown> = {}) => ({
  session_id: '5f0c2b9e-1111-4222-8333-944455556666',
  prompt_id: 'prompt-2',
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'Đã xong.',
  cwd: '/Users/learner/projects/demo',
  permission_mode: 'default',
  ...patch,
});
const emptyWindow = { userPrompt: null, tools: [], platform: null, parsed: false };

describe('skill constants mirror the ingest contract', () => {
  it('caps and patterns match', () => {
    expect(skill.USER_PROMPT_MAX_CHARS).toBe(contract.USER_PROMPT_MAX_CHARS);
    expect(skill.ASSISTANT_FINAL_MAX_CHARS).toBe(contract.ASSISTANT_FINAL_MAX_CHARS);
    expect(skill.CLIENT_TARGET_BYTES).toBe(contract.CLIENT_TARGET_BYTES);
    expect(skill.TOOLS_MAX).toBe(contract.TOOLS_MAX);
    expect(skill.MCP_TOOLS_MAX).toBe(contract.MCP_TOOLS_MAX);
    expect(skill.REDACTION_KINDS_MAX).toBe(contract.REDACTION_KINDS_MAX);
    expect(skill.INGEST_TOKEN_PATTERN.source).toBe(contract.INGEST_TOKEN_PATTERN.source);
    expect(contract.INGEST_ADAPTERS).toContain(skill.ADAPTER);
  });
});

describe('buildTurnPayload', () => {
  it('builds a schema-valid payload from the recorded transcript fixture', () => {
    const window = readTranscriptWindow(fixture('transcripts/claude-code-2.1.304-mission-turn.jsonl'));
    const payload = buildTurnPayload({ input: input(), window, installSalt: SALT, now: NOW });
    const parsed = contract.ingestTurnV1Schema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(payload.turn.platform).toEqual({ mcpTools: ['get_mission', 'start_mission', 'get_run'], missionId: 'plan-weekend', runId: 'run_ab12cd34' });
    expect(payload.turn.userPrompt).toContain('[REDACTED:email]');
    expect(payload.turn.userPrompt).not.toContain('hoc.vien@example.com');
    expect(payload.redaction.kinds).toContain('email');
    expect(JSON.stringify(payload)).not.toContain('/Users/learner/projects/demo');
    expect(Object.keys(payload)).not.toContain('cwd');
  });

  it('never leaks secrets from the transcript into the payload', () => {
    const window = readTranscriptWindow(fixture('transcripts/prompt-with-secrets.jsonl'));
    const payload = buildTurnPayload({ input: input({ last_assistant_message: 'Dùng sk-proj-ZZZZZZZZZZZZZZZZZZZZ1234 nhé' }), window, installSalt: SALT, now: NOW });
    const body = JSON.stringify(payload);
    for (const secret of ['sk-ant-api03-AbCdEf', 'ghp_AbCdEf', 'sk-proj-ZZZZ', '/Users/learner']) expect(body).not.toContain(secret);
    expect(payload.redaction.count).toBeGreaterThanOrEqual(3);
    expect(contract.ingestTurnV1Schema.safeParse(payload).success).toBe(true);
  });

  it('accepts a null prompt (unparseable transcript) and omits platform', () => {
    const payload = buildTurnPayload({ input: input(), window: emptyWindow, installSalt: SALT, now: NOW });
    expect(payload.turn.userPrompt).toBeNull();
    expect(payload.turn.platform).toBeUndefined();
    expect(contract.ingestTurnV1Schema.safeParse(payload).success).toBe(true);
  });

  it('truncates to the field caps and the 16 KB target, assistant text first', () => {
    const big = 'ă'.repeat(20_000);
    const payload = buildTurnPayload({
      input: input({ last_assistant_message: big }), window: { ...emptyWindow, userPrompt: 'ơ'.repeat(9_000), parsed: true }, installSalt: SALT, now: NOW,
    });
    expect(payload.truncated).toBe(true);
    expect(payload.turn.userPrompt.length).toBeLessThanOrEqual(contract.USER_PROMPT_MAX_CHARS);
    expect(payload.turn.assistantFinal.length).toBeLessThanOrEqual(contract.ASSISTANT_FINAL_MAX_CHARS);
    expect(contract.utf8Bytes(JSON.stringify(payload))).toBeLessThanOrEqual(contract.CLIENT_TARGET_BYTES);
    expect(contract.ingestTurnV1Schema.safeParse(payload).success).toBe(true);
  });

  it('derives the documented idempotency key and session ref; stop_hook_active keeps the key', () => {
    const first = buildTurnPayload({ input: input(), window: emptyWindow, installSalt: SALT, now: NOW });
    const refire = buildTurnPayload({ input: input({ stop_hook_active: true, last_assistant_message: 'khác' }), window: emptyWindow, installSalt: SALT, now: NOW });
    expect(first.idempotencyKey).toBe(sha256Hex('5f0c2b9e-1111-4222-8333-944455556666:prompt-2'));
    expect(refire.idempotencyKey).toBe(first.idempotencyKey);
    expect(refire.stopHookActive).toBe(true);
    expect(first.sessionRef).toBe(sha256Hex(`5f0c2b9e-1111-4222-8333-944455556666${SALT}`));
    expect(JSON.stringify(first)).not.toContain('5f0c2b9e-1111');
    const noPromptId = idempotencyKeyFor({ session_id: 's', last_assistant_message: 'x' });
    expect(noPromptId).toBe(sha256Hex(`s:${sha256Hex('x')}`));
  });
});
