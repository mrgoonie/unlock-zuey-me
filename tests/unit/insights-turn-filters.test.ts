/** ai-tutor pre-filters: trivial and duplicate turns never reach a model call; platform touch detection. */
import { describe, expect, it } from 'vitest';
import { filterWindow, isTrivialTurn, parseQueuedTurn, touchesPlatform, type QueuedTurn } from '../../src/lib/insights/turn-filters';

const LONG_REPLY = 'Đây là kế hoạch chi tiết cho cuối tuần của bạn, gồm lịch trình, ngân sách và những điểm cần tự kiểm tra lại.';
const turn = (over: Partial<QueuedTurn> = {}): QueuedTurn => ({
  userPrompt: 'Lập kế hoạch cuối tuần cho gia đình 4 người', assistantFinal: LONG_REPLY, tools: [], ...over,
});
const ev = (id: string, t: unknown) => ({ id, payloadJson: JSON.stringify(t) });

describe('parseQueuedTurn', () => {
  it('accepts a whole v1 body or a bare turn, and rejects junk', () => {
    expect(parseQueuedTurn(JSON.stringify({ v: 1, turn: turn() }))).toEqual(turn());
    expect(parseQueuedTurn(JSON.stringify(turn()))).toEqual(turn());
    expect(parseQueuedTurn(null)).toBeNull();
    expect(parseQueuedTurn('{not json')).toBeNull();
    expect(parseQueuedTurn(JSON.stringify({ turn: { userPrompt: 1 } }))).toBeNull();
  });
});

describe('isTrivialTurn', () => {
  it('flags a missing prompt with a short reply, and a tiny prompt without tools', () => {
    expect(isTrivialTurn(turn({ userPrompt: null, assistantFinal: 'Xong.' }))).toBe(true);
    expect(isTrivialTurn(turn({ userPrompt: null }))).toBe(false);
    expect(isTrivialTurn(turn({ userPrompt: 'ok' }))).toBe(true);
    expect(isTrivialTurn(turn({ userPrompt: 'ok', tools: [{ name: 'Bash', ok: true, count: 1 }] }))).toBe(false);
    expect(isTrivialTurn(turn())).toBe(false);
  });
});

describe('filterWindow', () => {
  it('keeps one of two identical events and marks the other duplicate', () => {
    const r = filterWindow([ev('a', turn()), ev('b', turn({ assistantFinal: `  ${LONG_REPLY}  ` })), ev('c', turn({ userPrompt: 'Một câu hỏi khác hẳn' }))]);
    expect(r.kept.map((k) => k.id)).toEqual(['a', 'c']);
    expect(r.dropped).toEqual([{ id: 'b', reason: 'duplicate' }]);
  });

  it('drops trivial and unreadable events and reports an empty window', () => {
    const r = filterWindow([ev('a', turn({ userPrompt: 'hi' })), { id: 'b', payloadJson: null }]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([{ id: 'a', reason: 'trivial' }, { id: 'b', reason: 'no_value' }]);
    expect(r.platformTouch).toBe(false);
  });

  it('flags platform touch from MCP tools, a mission or a run of a kept event only', () => {
    expect(touchesPlatform(turn({ platform: { mcpTools: ['start_mission'] } }))).toBe(true);
    expect(touchesPlatform(turn({ platform: { mcpTools: [], missionId: 'plan-weekend' } }))).toBe(true);
    expect(touchesPlatform(turn({ platform: { mcpTools: [], runId: 'run_1' } }))).toBe(true);
    expect(touchesPlatform(turn({ platform: { mcpTools: [] } }))).toBe(false);
    expect(touchesPlatform(turn())).toBe(false);
    // The only platform-touching event is trivial, so the window does not count as touching the platform.
    const r = filterWindow([ev('a', turn()), ev('b', turn({ userPrompt: 'ok', platform: { mcpTools: ['start_mission'] } }))]);
    expect(r.platformTouch).toBe(false);
  });
});
