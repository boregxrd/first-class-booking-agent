import type { BookingService } from '../../../model.js';
import type { Env } from '../../types/env.js';
import { OpenAIModelClient } from '../agent/client.js';
import { createConversationProcessor } from '../conversations/processor.js';
import type { ConversationStore } from '../conversations/store.js';
import { D1ConversationControls } from '../conversations/controls.js';
import { MetaInstagramProfileReader } from '../../channels/instagram-profile.js';

/** Composition boundary: the Calendar implementation is supplied by Part B. */
export function createAgentProcessor(env: Env, store: ConversationStore, bookings: BookingService) {
  const profiles = new MetaInstagramProfileReader(env);
  return createConversationProcessor({
    model: new OpenAIModelClient({ apiKey: env.OPENAI_API_KEY ?? '', model: env.OPENAI_MODEL }),
    store,
    bookings,
    controls: env.DB ? new D1ConversationControls(env.DB) : undefined,
    getInstagramProfile: (identity) => profiles.getProfile(identity),
  });
}
