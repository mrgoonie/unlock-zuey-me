/**
 * "Phòng thí nghiệm ngữ cảnh" lab: context cards → limited context window → new chat forgets → takeaway.
 * Score = correct answers to the three check questions.
 */
import { useMemo, useState } from 'react';
import { CHECKS } from '../../lib/labs/context-lab-data';
import { requireLab } from '../../lib/labs/registry';
import ContextCardsChat from './ContextCardsChat';
import ContextWindowDemo from './ContextWindowDemo';
import LabIntro from './LabIntro';
import LabStepHeading from './LabStepHeading';
import LabTakeaway from './LabTakeaway';
import NewChatDemo from './NewChatDemo';
import { useLabStarted } from './use-lab-started';

type Phase = 'intro' | 'cards' | 'window' | 'newChat' | 'done';
type CheckId = keyof typeof CHECKS;

const lab = requireLab('context-lab');
const TOTAL_STEPS = 4;

export default function ContextLab() {
  const [phase, setPhase] = useState<Phase>('intro');
  const [checks, setChecks] = useState<Partial<Record<CheckId, boolean>>>({});
  const [attempt, setAttempt] = useState(0);
  useLabStarted(lab.id, phase !== 'intro');

  const answer = (id: CheckId) => (correct: boolean) => setChecks((c) => ({ ...c, [id]: correct }));
  const result = useMemo(
    () => ({ score: Object.values(checks).filter(Boolean).length, total: Object.keys(CHECKS).length }),
    [checks],
  );

  if (phase === 'intro') {
    return (
      <LabIntro
        lab={lab}
        bullets={['Thêm bớt thông tin và xem AI trả lời khác đi thế nào', 'Vì sao chat dài thì AI "quên" lời dặn đầu tiên', 'Vì sao mở chat mới là AI không nhớ gì']}
        onStart={() => setPhase('cards')}
      />
    );
  }

  if (phase === 'done') {
    return (
      <LabTakeaway
        lab={lab}
        result={result}
        step={TOTAL_STEPS}
        onRestart={() => {
          setChecks({});
          setAttempt((a) => a + 1);
          setPhase('cards');
        }}
        takeaway='AI chỉ dùng được những gì đang nằm trên "bàn" (ngữ cảnh). Bàn có giới hạn, và mỗi cuộc trò chuyện mới là một bàn trống.'
        tips={[
          'Nói rõ ngân sách, người đi cùng, ràng buộc ngay từ đầu.',
          'Chat dài thì nhắc lại điều quan trọng ở gần cuối.',
          'Mở chat mới thì dán lại một đoạn tóm tắt ngắn.',
        ]}
      />
    );
  }

  const steps = {
    cards: { n: 1, title: 'Đặt thẻ lên bàn 🃏', body: <ContextCardsChat onAnswered={answer('plan')} onNext={() => setPhase('window')} /> },
    window: { n: 2, title: 'Bàn đầy rồi! 📚', body: <ContextWindowDemo onAnswered={answer('window')} onNext={() => setPhase('newChat')} /> },
    newChat: { n: 3, title: 'Chat mới = bàn trống 🧽', body: <NewChatDemo onAnswered={answer('newChat')} onNext={() => setPhase('done')} /> },
  }[phase];

  return (
    <section key={`${attempt}-${phase}`}>
      <LabStepHeading step={steps.n} total={TOTAL_STEPS} title={steps.title} />
      {steps.body}
    </section>
  );
}
