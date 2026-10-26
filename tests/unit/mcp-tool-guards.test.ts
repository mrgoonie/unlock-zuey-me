import { describe, expect, it, vi } from 'vitest';
import { getMission } from '../../src/lib/content/loader';
import { LearningError, type LearnerContext } from '../../src/lib/learning/types';
import { consentScopes } from '../../src/lib/mcp/mcp-scopes';
import { missionPublicView } from '../../src/lib/mcp/mission-public-view';
import { errorToToolResult, runTool, toolOk, type McpToolContext } from '../../src/lib/mcp/tool-results';

const learner: LearnerContext = {
  id: 'lrn_a', kind: 'member', email: 'a@example.com', displayName: 'A', avatarUrl: null,
  isAdmin: false, observerConsent: false, profile: {},
};
const ctx = (scopes: string[]): McpToolContext => ({ env: {} as Env, learner, scopes });

describe('MCP tool guards', () => {
  it('refuses write tools for a learn:read token without running the body', async () => {
    const body = vi.fn(async () => toolOk({ ok: true }));
    const result = await runTool(ctx(['learn:read']), 'start_mission', 'write', body);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'insufficient_scope' } });
    expect(body).not.toHaveBeenCalled();
  });

  it('treats learn:write as implying learn:read and refuses tokens with neither', async () => {
    const body = vi.fn(async () => toolOk({ ok: true }));
    expect((await runTool(ctx(['learn:write']), 'get_run', 'read', body)).isError).toBeUndefined();
    expect((await runTool(ctx([]), 'get_run', 'read', body)).isError).toBe(true);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('maps LearningError codes and hides unexpected errors', () => {
    const notFound = errorToToolResult(new LearningError('not_found', 'Không tìm thấy.'), 'get_run');
    expect(notFound).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const internal = errorToToolResult(new Error('SQLITE_ERROR: secret detail'), 'get_run');
    expect(JSON.stringify(internal)).not.toContain('secret detail');
    expect(internal.structuredContent).toMatchObject({ error: { code: 'internal' } });
    spy.mockRestore();
  });

  it('returns structuredContent and the same JSON as text', () => {
    const r = toolOk({ run: { id: 'run_1' } }, 'Run started.');
    expect(r.structuredContent).toEqual({ run: { id: 'run_1' } });
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect((r.content[0] as { text: string }).text).toContain('{"run":{"id":"run_1"}}');
  });

  it('offers requested known scopes on the consent page, all of them when none were requested', () => {
    expect(consentScopes(['learn:read', 'openid'])).toEqual(['learn:read']);
    expect(consentScopes([])).toEqual(['learn:read', 'learn:write']);
  });
});

describe('get_mission public view', () => {
  it('never exposes rubric answers, explanations, hints or grader guidance', () => {
    const mission = getMission('plan-weekend');
    expect(mission).toBeDefined();
    const json = JSON.stringify(missionPublicView(mission!));
    for (const secret of ['"answer"', '"correct"', '"explanation"', '"hints"', '"guidance"', '"check"', '"step_refs"']) {
      expect(json, secret).not.toContain(secret);
    }
    for (const step of mission!.steps) {
      if (step.type === 'verification') for (const c of step.claims) expect(json).not.toContain(c.explanation);
      if (step.type === 'quiz') for (const q of step.questions) expect(json).not.toContain(q.explanation);
      for (const hint of step.hints) expect(json).not.toContain(hint);
    }
    expect(json).toContain('"answerFields"');
  });
});
