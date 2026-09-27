import type { BookingService } from '../../../model.js';
import type { Env } from '../../types/env.js';
import { OpenAIModelClient } from '../agent/client.js';
import { createConversationProcessor } from '../conversations/processor.js';
import type { ConversationStore } from '../conversations/store.js';

/** Composition boundary: the Calendar implementation is supplied by Part B. */
export function createAgentProcessor(env: Env, store: ConversationStore, bookings: BookingService) {
  return createConversationProcessor({
    model: new OpenAIModelClient({ apiKey: env.OPENAI_API_KEY ?? '', model: env.OPENAI_MODEL }),
    store,
    bookings,
  });
}
