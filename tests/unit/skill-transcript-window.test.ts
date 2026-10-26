/** Transcript window parser: latest learner prompt + tools after it, defensive against format drift. */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseTranscriptLines, readTailLines, readTranscriptWindow,
} from '../../skills/ai-unlocked/scripts/lib/transcript-window.mjs';
import { fixture, makeTempEnv, type TempEnv } from '../fixtures/skill/skill-test-helpers';

describe('readTranscriptWindow', () => {
  it('finds the latest typed prompt, skipping meta, task notifications, tool results and sidechain lines', () => {
    const w = readTranscriptWindow(fixture('transcripts/claude-code-2.1.304-mission-turn.jsonl'));
    expect(w.parsed).toBe(true);
    expect(w.userPrompt).toBe('Giúp mình bắt đầu nhiệm vụ plan-weekend nhé. Email của mình là hoc.vien@example.com');
    expect(w.tools).toEqual([
      { name: 'mcp__ai-unlocked__get_mission', ok: true, count: 1 },
      { name: 'mcp__ai-unlocked__start_mission', ok: true, count: 1 },
      { name: 'mcp__ai-unlocked__get_run', ok: true, count: 1 },
      { name: 'Bash', ok: false, count: 2 },
    ]);
    expect(w.platform).toEqual({ mcpTools: ['get_mission', 'start_mission', 'get_run'], missionId: 'plan-weekend', runId: 'run_ab12cd34' });
  });

  it('joins text parts of an array prompt and survives a torn last line', () => {
    const w = readTranscriptWindow(fixture('transcripts/text-parts-torn-tail.jsonl'));
    expect(w.userPrompt).toBe('Phần 1 của câu hỏi\nPhần 2');
    expect(w.tools).toEqual([{ name: 'WebSearch', ok: true, count: 1 }]);
    expect(w.platform).toBeNull();
  });

  it('yields {userPrompt: null, tools: []} for garbage, a missing file, a directory or a non-string path', () => {
    const empty = { userPrompt: null, tools: [], platform: null, parsed: false };
    expect(readTranscriptWindow(fixture('transcripts/garbage.jsonl'))).toEqual(empty);
    expect(readTranscriptWindow(fixture('transcripts/missing.jsonl'))).toEqual(empty);
    expect(readTranscriptWindow(fixture('transcripts'))).toEqual(empty);
    expect(readTranscriptWindow(42)).toEqual(empty);
  });

  it('ignores MCP tools of other servers and ids that do not match the server patterns', () => {
    const lines = [
      { type: 'user', message: { role: 'user', content: 'go' } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'a', name: 'mcp__github__get_profile', input: {} },
        { type: 'tool_use', id: 'b', name: 'mcp__ai-unlocked__start_mission', input: { mission_id: 'BAD ID' } },
        { type: 'tool_use', id: 'c', name: 'mcp__ai-unlocked__get_run', input: { run_id: 'not-a-run' } },
        { type: 'tool_use', id: 'd', name: 'weird name with spaces', input: {} },
      ] } },
    ].map((l) => JSON.stringify(l));
    const w = parseTranscriptLines(lines);
    expect(w.platform).toEqual({ mcpTools: ['start_mission', 'get_run'] });
    expect(w.tools.map((t) => t.name)).toEqual(['mcp__github__get_profile', 'mcp__ai-unlocked__start_mission', 'mcp__ai-unlocked__get_run']);
  });

  it('caps distinct tools at 50 and counts at 1000', () => {
    const uses = Array.from({ length: 60 }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: `Tool${i}`, input: {} }));
    const repeats = Array.from({ length: 1100 }, (_, i) => ({ type: 'tool_use', id: `r${i}`, name: 'Tool0', input: {} }));
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { content: [...uses, ...repeats] } }),
    ];
    const w = parseTranscriptLines(lines);
    expect(w.tools).toHaveLength(50);
    expect(w.tools[0]).toEqual({ name: 'Tool0', ok: true, count: 1000 });
  });
});

describe('readTailLines', () => {
  let t: TempEnv;
  beforeEach(() => { t = makeTempEnv(); });
  afterEach(() => t.cleanup());

  it('reads only the last 512 KB and drops the partial first line', () => {
    const file = path.join(t.root, 'big.jsonl');
    const filler = `${JSON.stringify({ type: 'attachment', pad: 'x'.repeat(1000) })}\n`;
    fs.writeFileSync(file, filler.repeat(800) + `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'tail prompt' } })}\n`);
    const lines = readTailLines(file) ?? [];
    const bytes = lines.join('\n').length;
    expect(bytes).toBeLessThanOrEqual(512 * 1024);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(readTranscriptWindow(file).userPrompt).toBe('tail prompt');
  });
});
