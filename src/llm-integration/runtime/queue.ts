import { z } from 'zod';
import type { InboundMessage } from '../../../model.js';
import type { TurnResult } from '../conversations/store.js';

const inboundSchema = z.object({
  identity: z.object({
    channel: z.enum(['instagram', 'whatsapp']),
    businessAccountId: z.string().min(1), senderId: z.string().min(1),
  }).strict(),
  providerMessageId: z.string().min(1),
  sentAt: z.string().datetime(), receivedAt: z.string().datetime(),
  text: z.string().trim().min(1).max(4000),
}).strict();

/** A successful processor must commit the reply to a durable outbound outbox. */
export function createQueueHandler(processMessage: (message: InboundMessage) => Promise<TurnResult>) {
  return async (batch: MessageBatch<unknown>): Promise<void> => {
    for (const message of batch.messages) {
      try {
        await processMessage(inboundSchema.parse(message.body));
        message.ack();
      } catch {
        // Configure finite retries + a DLQ when connecting the queue. No customer text in logs.
        console.error('[Queue] Conversation processing failed', { queueMessageId: message.id });
        message.retry({ delaySeconds: 30 });
      }
    }
  };
}

/** Fail closed until a durable store, BookingService and outbox dispatcher are wired. */
export async function handleQueue(_batch: MessageBatch<unknown>): Promise<void> {
  throw new Error('Queue processor is not configured; durable conversation and booking adapters are required');
}
