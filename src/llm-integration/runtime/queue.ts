import type { Env } from '../../types/env.js';
import { createServices } from '../../runtime/factory.js';
import { drainInbox } from './inbox.js';
import { dispatchOutbox } from './outbox.js';

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (!env.DB) throw new Error('D1 binding DB is required');
  // Queue is only a wake-up. Durable payloads and FIFO order come from D1.
  if (env.META_MESSAGING_MODE === 'live' || env.META_MESSAGING_MODE === 'test') {
    const services = createServices(env);
    await drainInbox(env.DB, (message) => services.processor(message), 3);
    await dispatchOutbox(env.DB, services.textSender);
  }
  batch.ackAll();
}
