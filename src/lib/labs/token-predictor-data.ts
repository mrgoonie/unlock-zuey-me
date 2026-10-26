/**
 * Authored data for the "Máy đoán chữ" lab. Probabilities are illustrative (hand-written to feel like a
 * real model), not measured from any specific model; the UI says so.
 */
import type { TokenOption } from './token-sampling';

export interface PredictRound {
  id: string;
  /** Sentence fragment; the learner guesses the next word. */
  prompt: string;
  /** Options in display order (top pick deliberately not always first). The most likely one is the "AI pick". */
  options: TokenOption[];
  /** One-line insight shown after the reveal. */
  insight: string;
}

export const PREDICT_ROUNDS: PredictRound[] = [
  {
    id: 'rain',
    prompt: 'Trời sắp mưa rồi, nhớ mang theo',
    options: [
      { token: 'áo mưa', p: 0.33 },
      { token: 'bánh mì', p: 0.05 },
      { token: 'ô', p: 0.46 },
      { token: 'dù', p: 0.16 },
    ],
    insight: 'Cả "ô", "áo mưa", "dù" đều hợp lý. AI không "biết" đáp án, nó chỉ thấy chữ nào hay đi sau câu này nhất.',
  },
  {
    id: 'thanks',
    prompt: 'Cảm ơn bạn rất',
    options: [
      { token: 'vui', p: 0.07 },
      { token: 'nhiều', p: 0.86 },
      { token: 'là', p: 0.05 },
      { token: 'mèo', p: 0.02 },
    ],
    insight: 'Câu quen thuộc thì AI rất chắc chắn: "nhiều" chiếm gần hết xác suất.',
  },
  {
    id: 'capital',
    prompt: 'Thủ đô của Việt Nam là',
    options: [
      { token: 'thành phố', p: 0.05 },
      { token: 'Huế', p: 0.02 },
      { token: 'một', p: 0.03 },
      { token: 'Hà', p: 0.9 },
    ],
    insight: 'AI đoán "Hà" trước, rồi mới đoán "Nội" ở lượt sau. Nó viết từng mẩu nhỏ (token), không viết cả câu một lúc.',
  },
  {
    id: 'weekend',
    prompt: 'Cuối tuần này mình định đi',
    options: [
      { token: 'biển', p: 0.24 },
      { token: 'chơi', p: 0.38 },
      { token: 'Đà Lạt', p: 0.2 },
      { token: 'ngủ', p: 0.18 },
    ],
    insight: 'Khi nhiều chữ đều hợp, xác suất chia đều hơn. Lúc này AI dễ trả lời khác nhau mỗi lần hỏi.',
  },
  {
    id: 'flan',
    prompt: 'Muốn bánh flan mịn, bí quyết là hấp',
    options: [
      { token: 'cách thuỷ', p: 0.3 },
      { token: 'thật lâu', p: 0.13 },
      { token: 'nhỏ lửa', p: 0.52 },
      { token: 'bằng lò vi sóng', p: 0.05 },
    ],
    insight: 'Nghe rất "chuyên gia", nhưng AI vẫn chỉ đang chọn chữ hay gặp. Mẹo nấu ăn vẫn nên thử lại hoặc tra công thức.',
  },
];

/** Round reused by the temperature playground: a flat-ish distribution shows sampling best. */
export const TEMPERATURE_ROUND_ID = 'weekend';

/** Confidence choices for the calibration step (percent). */
export const CONFIDENCE_LEVELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 30, label: 'Đoán bừa' },
  { value: 50, label: 'Hơi chắc' },
  { value: 70, label: 'Khá chắc' },
  { value: 90, label: 'Chắc nịch' },
];

/** Sample texts for the tokenizer view. */
export const TOKENIZER_SAMPLES: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'Tiếng Việt', text: 'Hôm nay trời đẹp quá, đi uống cà phê không?' },
  { label: 'English', text: 'The weather is lovely today, want to grab a coffee?' },
];
