/**
 * "Máy đoán chữ" lab: guess rounds with confidence → temperature playground → tokenizer view → takeaway.
 * Score = rounds where the learner matched the AI's top pick; calibration from stated confidence.
 */
import { useMemo, useState } from 'react';
import { calibrationScore, calibrationTone, type Prediction } from '../../lib/labs/calibration';
import { requireLab } from '../../lib/labs/registry';
import { PREDICT_ROUNDS, TEMPERATURE_ROUND_ID } from '../../lib/labs/token-predictor-data';
import LabIntro from './LabIntro';
import LabStepHeading from './LabStepHeading';
import LabTakeaway from './LabTakeaway';
import TemperaturePlayground from './TemperaturePlayground';
import TokenGuessRound from './TokenGuessRound';
import TokenizerView from './TokenizerView';
import { useLabStarted } from './use-lab-started';

type Phase = { kind: 'intro' } | { kind: 'round'; index: number } | { kind: 'temperature' } | { kind: 'tokenizer' } | { kind: 'done' };

const lab = requireLab('token-predictor');
const ROUNDS = PREDICT_ROUNDS.length;
const TOTAL_STEPS = ROUNDS + 3;
const tempRound = PREDICT_ROUNDS.find((r) => r.id === TEMPERATURE_ROUND_ID) ?? PREDICT_ROUNDS[0];

const TONE_TEXT = {
  over: 'Bạn hơi tự tin quá so với số lần đúng. AI cũng hay như vậy: nói rất chắc nhưng chưa chắc đúng.',
  under: 'Bạn đoán đúng nhiều hơn bạn nghĩ đấy! Cứ tin vào trực giác thêm chút.',
  good: 'Độ tự tin của bạn khớp khá tốt với số lần đúng. Đây là kỹ năng quý khi làm việc với AI.',
};

export default function TokenPredictorLab() {
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' });
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [attempt, setAttempt] = useState(0);
  useLabStarted(lab.id, phase.kind !== 'intro');

  const result = useMemo(() => {
    const calibration = calibrationScore(predictions);
    return {
      score: predictions.filter((p) => p.correct).length,
      total: ROUNDS,
      ...(calibration === null ? {} : { calibration }),
    };
  }, [predictions]);

  const restart = () => {
    setPredictions([]);
    setAttempt((a) => a + 1);
    setPhase({ kind: 'round', index: 0 });
  };

  if (phase.kind === 'intro') {
    return (
      <LabIntro
        lab={lab}
        bullets={['Đoán chữ tiếp theo như một AI', 'Xem vì sao cùng câu hỏi mà AI trả lời mỗi lần một khác', 'Nhìn AI "cắt chữ" thành token']}
        onStart={() => setPhase({ kind: 'round', index: 0 })}
      />
    );
  }

  if (phase.kind === 'round') {
    const round = PREDICT_ROUNDS[phase.index];
    return (
      <section>
        <LabStepHeading step={phase.index + 1} total={TOTAL_STEPS} title={`Đoán chữ ${phase.index + 1}/${ROUNDS}`} />
        <TokenGuessRound
          key={`${attempt}-${round.id}`}
          round={round}
          isLast={phase.index === ROUNDS - 1}
          onDone={(p) => {
            setPredictions((prev) => [...prev, p]);
            setPhase(phase.index + 1 < ROUNDS ? { kind: 'round', index: phase.index + 1 } : { kind: 'temperature' });
          }}
        />
      </section>
    );
  }

  if (phase.kind === 'temperature') {
    return (
      <section>
        <LabStepHeading step={ROUNDS + 1} total={TOTAL_STEPS} title="Tung xúc xắc chữ 🎲" />
        <TemperaturePlayground round={tempRound} onNext={() => setPhase({ kind: 'tokenizer' })} />
      </section>
    );
  }

  if (phase.kind === 'tokenizer') {
    return (
      <section>
        <LabStepHeading step={ROUNDS + 2} total={TOTAL_STEPS} title="Kính lúp token 🔍" />
        <TokenizerView onNext={() => setPhase({ kind: 'done' })} />
      </section>
    );
  }

  return (
    <LabTakeaway
      lab={lab}
      result={result}
      step={TOTAL_STEPS}
      onRestart={restart}
      takeaway='AI viết bằng cách đoán từng mẩu chữ (token) dễ xảy ra nhất, có chút ngẫu nhiên. Nó giỏi viết cho "nghe hợp lý", chứ không tự kiểm tra đúng sai.'
      tips={[
        'Hỏi lại cùng một câu có thể ra câu trả lời khác: đó là chuyện bình thường.',
        'Câu trả lời trôi chảy, tự tin không có nghĩa là đúng. Việc quan trọng thì kiểm chứng.',
        'Tiếng Việt tốn nhiều token hơn tiếng Anh, nên đoạn chat dài sẽ "đầy bàn" nhanh hơn.',
      ]}
    >
      <p className="card mt-4 text-sm">🎯 {TONE_TEXT[calibrationTone(predictions)]}</p>
    </LabTakeaway>
  );
}
