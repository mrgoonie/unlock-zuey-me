/** Picks the renderer for a step type. Every type in src/lib/content/schema.ts stepSchema is handled. */
import type { StepProps } from './steps/step-props';
import AiTaskStep from './steps/AiTaskStep';
import { PredictionStep, QuizStep } from './steps/QuizSteps';
import { GuidedInputStep, IntroStep, ReflectionStep } from './steps/SimpleSteps';
import VerificationStep from './steps/VerificationStep';

export default function StepView(props: StepProps) {
  const { step } = props;
  switch (step.type) {
    case 'intro': return <IntroStep {...props} step={step} />;
    case 'guided-input': return <GuidedInputStep {...props} step={step} />;
    case 'ai-task': return <AiTaskStep {...props} step={step} />;
    case 'verification': return <VerificationStep {...props} step={step} />;
    case 'quiz': return <QuizStep {...props} step={step} />;
    case 'prediction': return <PredictionStep {...props} step={step} />;
    case 'reflection': return <ReflectionStep {...props} step={step} />;
  }
}
