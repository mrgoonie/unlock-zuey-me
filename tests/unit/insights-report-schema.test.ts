/** ai-tutor report contract: confidence and provenance required, evidence refs checked, no hidden-reasoning claims. */
import { describe, expect, it } from 'vitest';
import {
  AiTutorReportError, aiTutorJsonSchema, buildStoredReport, citedRefs, parseAiTutorReport, validateAiTutorReport, windowRefs,
} from '../../src/lib/insights/ai-tutor-report-schema';
import type { AiTutorReport } from '../../src/lib/insights/insight-types';

const ctx = { refs: windowRefs(3), missionIds: new Set(['plan-weekend']) };

const validReport = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  relevant: true,
  intent_summary: { text: 'Bạn nhờ AI lập kế hoạch cuối tuần cho gia đình.', confidence: 0.8 },
  workflow_observed: [{ step: 'Đưa ra ràng buộc ngân sách', evidence_ref: 'e1' }],
  learning_insights: [{ skill: 'describe', note: 'Bạn nêu rõ ràng buộc ngay từ đầu.' }],
  verification_gaps: [{ note: 'Chưa kiểm tra giờ mở cửa.', evidence_ref: 'e2' }],
  risk_signals: [{ kind: 'unverified_claim', note: 'Chấp nhận giá vé mà chưa tra.', evidence_ref: 'e3' }],
  next_best_action: { text: 'Thử nhiệm vụ lập kế hoạch cuối tuần.', mission_id: 'plan-weekend' },
  product_observation: null,
  confidence: 0.7,
  ...over,
});

describe('validateAiTutorReport', () => {
  it('accepts a well-formed report and lists its cited refs', () => {
    const r = parseAiTutorReport(`\`\`\`json\n${JSON.stringify(validReport())}\n\`\`\``, ctx);
    expect(r.next_best_action).toEqual({ text: 'Thử nhiệm vụ lập kế hoạch cuối tuần.', mission_id: 'plan-weekend' });
    expect(citedRefs(r)).toEqual(['e1', 'e2', 'e3']);
  });

  it('requires confidence on the report and on the intent summary', () => {
    const { confidence: _c, ...noConfidence } = validReport();
    expect(() => validateAiTutorReport(noConfidence, ctx)).toThrow(AiTutorReportError);
    expect(() => validateAiTutorReport(validReport({ intent_summary: { text: 'x' } }), ctx)).toThrow(AiTutorReportError);
    expect(validateAiTutorReport(validReport({ confidence: 7 }), ctx).confidence).toBe(1);
  });

  it('drops items citing an event outside the window (e9 in a 3-event window)', () => {
    const r = validateAiTutorReport(validReport({
      workflow_observed: [{ step: 'Bước thật', evidence_ref: 'e1' }, { step: 'Bước bịa', evidence_ref: 'e9' }],
      risk_signals: [{ kind: 'overreliance', note: 'x', evidence_ref: 'e9' }],
      product_observation: { category: 'bug', area: 'mcp', topic_key: 'start-mission-error', summary: 'Lỗi', evidence_ref: 'e9', confidence: 0.9 },
    }), ctx);
    expect(r.workflow_observed).toEqual([{ step: 'Bước thật', evidence_ref: 'e1' }]);
    expect(r.risk_signals).toEqual([]);
    expect(r.product_observation).toBeNull();
  });

  it('drops unknown missions, skills and areas instead of trusting them', () => {
    const r = validateAiTutorReport(validReport({
      next_best_action: { text: 'Làm nhiệm vụ', mission_id: 'no-such-mission' },
      learning_insights: [{ skill: 'hacking', note: 'x' }, { skill: 'verify', note: 'Kiểm tra lại' }],
      product_observation: { category: 'content', area: 'mission:no-such-mission', topic_key: 'x', summary: 'y', evidence_ref: 'e1', confidence: 0.5 },
    }), ctx);
    expect(r.next_best_action).toEqual({ text: 'Làm nhiệm vụ' });
    expect(r.learning_insights).toEqual([{ skill: 'verify', note: 'Kiểm tra lại' }]);
    expect(r.product_observation).toBeNull();
    const ok = validateAiTutorReport(validReport({
      product_observation: { category: 'content', area: 'mission:plan-weekend', topic_key: 'Unclear-Step', summary: 'Bước 2 khó hiểu', evidence_ref: 'e1', confidence: 0.5 },
    }), ctx);
    expect(ok.product_observation).toMatchObject({ area: 'mission:plan-weekend', topic_key: 'unclear-step' });
  });

  it('rejects any claim of access to hidden reasoning or chain-of-thought (English and Vietnamese)', () => {
    for (const text of [
      'chain-of-thought của mô hình cho thấy bạn đã bối rối',
      'The hidden reasoning shows doubt',
      'Suy luận ẩn của Claude là…',
      'suy nghĩ nội bộ của AI',
    ]) {
      expect(() => validateAiTutorReport(validReport({ intent_summary: { text, confidence: 0.5 } }), ctx)).toThrow(/hidden reasoning/);
    }
  });

  it('caps list lengths and text lengths', () => {
    const r = validateAiTutorReport(validReport({
      workflow_observed: Array.from({ length: 9 }, () => ({ step: 's'.repeat(400), evidence_ref: 'e1' })),
    }), ctx);
    expect(r.workflow_observed).toHaveLength(6);
    expect(r.workflow_observed[0].step).toHaveLength(160);
  });
});

describe('buildStoredReport', () => {
  const report = validateAiTutorReport(validReport(), ctx) as AiTutorReport;

  it('attaches provenance: runtime, time, model, prompt version and evidence refs', () => {
    const s = buildStoredReport(report, { sourceRuntime: 'claude-code', createdAt: '2026-10-26T16:00:00.000Z', model: 'google/gemini-3.1-flash-lite' });
    expect(s).toMatchObject({ source_runtime: 'claude-code', model: 'google/gemini-3.1-flash-lite', prompt_version: 1, evidence_refs: ['e1', 'e2', 'e3'] });
  });

  it('refuses a report without provenance', () => {
    expect(() => buildStoredReport(report, { sourceRuntime: '', createdAt: '2026-10-26T16:00:00.000Z', model: 'm' })).toThrow(AiTutorReportError);
    expect(() => buildStoredReport(report, { sourceRuntime: 'claude-code', createdAt: 'yesterday', model: 'm' })).toThrow(AiTutorReportError);
    expect(() => buildStoredReport(report, { sourceRuntime: 'claude-code', createdAt: '2026-10-26T16:00:00.000Z', model: '' })).toThrow(AiTutorReportError);
  });
});

describe('aiTutorJsonSchema', () => {
  it('limits evidence refs to the window and areas to known values', () => {
    const spec = aiTutorJsonSchema(windowRefs(2), ['plan-weekend']);
    const json = JSON.stringify(spec.schema);
    expect(json).toContain('"enum":["e1","e2"]');
    expect(json).toContain('mission:plan-weekend');
    expect((spec.schema as { required: string[] }).required).toContain('confidence');
  });
});
