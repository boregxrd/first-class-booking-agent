import type { ChannelIdentity } from '../../../model.js';
import type { Env } from '../../types/env.js';

/** Default observe-only while the gym's existing bot is active. IDs, never usernames. */
export function canProcessMessages(identity: ChannelIdentity, env: Env): boolean {
  if (env.META_MESSAGING_MODE === 'live') return true;
  if (env.META_MESSAGING_MODE !== 'test') return false;
  const allowed = identity.channel === 'instagram' ? env.META_TEST_INSTAGRAM_SENDER_IDS : env.META_TEST_WHATSAPP_SENDER_IDS;
  return (allowed ?? '').split(',').map((id) => id.trim()).filter(Boolean).includes(identity.senderId);
}
