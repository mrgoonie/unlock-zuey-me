import { z } from 'zod';
import { json, readBody } from '../../../../lib/http/api-response';
import { sendPracticeChat } from '../../../../lib/learning/service';
import { withLearner } from '../_route-helpers';

// Message count/length limits are enforced in practice-chat-service.ts.
const body = z.object({
  runId: z.string().max(80).optional(),
  stepId: z.string().max(64).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1).max(50),
});

/** POST /api/v1/coach/chat → { reply, model, remainingToday } */
export const POST = withLearner(async ({ request }, learner, deps) => {
  const parsed = await readBody(request, body);
  if ('response' in parsed) return parsed.response;
  return json(await sendPracticeChat(deps, learner, parsed.data));
});
