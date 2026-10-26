/**
 * "Thám tử ảo giác" lab: classify claims across several cases, then review score and red-flag patterns.
 * Score = claims classified with an accepted verdict.
 */
import { useMemo, useState } from 'react';
import { RED_FLAGS, scoreVerdicts, tallyRedFlags, type ClaimVerdict } from '../../lib/labs/detective-scoring';
import { ALL_CLAIMS, DETECTIVE_CASES } from '../../lib/labs/hallucination-detective-data';
import { requireLab } from '../../lib/labs/registry';
import DetectiveCaseView from './DetectiveCaseView';
import LabIntro from './LabIntro';
import LabStepHeading from './LabStepHeading';
import LabTakeaway from './LabTakeaway';
import { useLabStarted } from './use-lab-started';

type Phase = { kind: 'intro' } | { kind: 'case'; index: number } | { kind: 'done' };

const lab = requireLab('hallucination-detective');
const CASES = DETECTIVE_CASES.length;
const TOTAL_STEPS = CASES + 1;
const FLAG_TALLY = tallyRedFlags(ALL_CLAIMS);

export default function HallucinationDetectiveLab() {
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' });
  const [answers, setAnswers] = useState<Record<string, ClaimVerdict>>({});
  const [attempt, setAttempt] = useState(0);
  useLabStarted(lab.id, phase.kind !== 'intro');

  const result = useMemo(() => scoreVerdicts(ALL_CLAIMS, answers), [answers]);

  if (phase.kind === 'intro') {
    return (
      <LabIntro
        lab={lab}
        bullets={[`${CASES} vụ án, mỗi vụ là một câu trả lời của AI`, 'Soi từng câu: tin được, cần tra lại, thiếu thông tin hay phải hỏi chuyên gia', 'Học 4 dấu hiệu AI hay bịa']}
        onStart={() => setPhase({ kind: 'case', index: 0 })}
      />
    );
  }

  if (phase.kind === 'case') {
    const item = DETECTIVE_CASES[phase.index];
    return (
      <section>
        <LabStepHeading step={phase.index + 1} total={TOTAL_STEPS} title={`${item.emoji} Vụ án ${phase.index + 1}/${CASES}`} />
        <DetectiveCaseView
          key={`${attempt}-${item.id}`}
          item={item}
          answers={answers}
          isLast={phase.index === CASES - 1}
          onAnswer={(claimId, verdict) => setAnswers((a) => (a[claimId] ? a : { ...a, [claimId]: verdict }))}
          onNext={() => setPhase(phase.index + 1 < CASES ? { kind: 'case', index: phase.index + 1 } : { kind: 'done' })}
        />
      </section>
    );
  }

  return (
    <LabTakeaway
      lab={lab}
      result={result}
      step={TOTAL_STEPS}
      onRestart={() => {
        setAnswers({});
        setAttempt((a) => a + 1);
        setPhase({ kind: 'case', index: 0 });
      }}
      takeaway="AI viết điều nghe hợp lý nhất, không phải điều đã kiểm chứng. Câu càng cụ thể, càng mới, càng liên quan tới sức khoẻ, tiền bạc, pháp lý thì càng phải tự kiểm tra."
      tips={[
        'Tra lại con số, giờ giấc, giá cả ở nguồn chính thức.',
        'Nếu AI đoán về bạn, hãy cung cấp thêm thông tin rồi hỏi lại.',
        'Sức khoẻ, thuốc men, thuế, đầu tư: hỏi bác sĩ, dược sĩ hoặc chuyên gia.',
      ]}
    >
      <div className="card mt-4">
        <p className="font-semibold">🚩 4 dấu hiệu cần cảnh giác</p>
        <ul className="mt-2 space-y-2 text-sm">
          {FLAG_TALLY.map(({ flag, count }) => (
            <li key={flag}>
              <span aria-hidden="true">{RED_FLAGS[flag].emoji}</span> <strong>{RED_FLAGS[flag].label}</strong>{' '}
              <span className="text-ink-muted">(gặp {count} lần)</span>
              <span className="block text-ink-muted">{RED_FLAGS[flag].tip}</span>
            </li>
          ))}
        </ul>
      </div>
    </LabTakeaway>
  );
}
