/**
 * Lab registry: the single list of interactive labs. Pages, the home module and the concept pages read
 * from here, so ids must match the `lab` enum in src/lib/content/schema.ts.
 */
export type LabId = 'token-predictor' | 'context-lab' | 'hallucination-detective';

export interface LabMeta {
  id: LabId;
  title: string;
  emoji: string;
  /** Estimated minutes to finish. */
  minutes: number;
  /** Concept page the lab ends on: /concepts/<conceptId>. */
  conceptId: string;
  summary: string;
}

export const LABS: readonly LabMeta[] = [
  {
    id: 'token-predictor',
    title: 'Máy đoán chữ',
    emoji: '🔮',
    minutes: 5,
    conceptId: 'token',
    summary: 'Thử đoán chữ tiếp theo như AI, rồi xem AI "tung xúc xắc" chọn chữ thế nào.',
  },
  {
    id: 'context-lab',
    title: 'Phòng thí nghiệm ngữ cảnh',
    emoji: '🧠',
    minutes: 5,
    conceptId: 'context',
    summary: 'Thêm bớt thông tin cho AI và xem câu trả lời đổi ra sao. Vì sao AI hay "quên"?',
  },
  {
    id: 'hallucination-detective',
    title: 'Thám tử ảo giác',
    emoji: '🕵️',
    minutes: 6,
    conceptId: 'hallucination',
    summary: 'Soi từng câu AI nói: câu nào tin được, câu nào phải tra lại, câu nào cần hỏi chuyên gia.',
  },
];

export const getLab = (id: string): LabMeta | undefined => LABS.find((l) => l.id === id);

/** Lookup for ids known at compile time (lab components); a miss is a programming error. */
export function requireLab(id: LabId): LabMeta {
  const lab = getLab(id);
  if (!lab) throw new Error(`unknown lab: ${id}`);
  return lab;
}
