import { Hono } from 'hono';
import { handleWebhookChallenge, processMetaWebhook } from './channels/meta.js';
import { Env } from './types/env.js';

// Initialize Hono with Cloudflare Workers environment bindings
const app = new Hono<{ Bindings: Env }>();

// ============================================================================
// HEALTH CHECK
// ============================================================================
app.get('/', (c) => c.text('First-Class Booking Agent (Cloudflare Worker) is running! 🚀'));

// ============================================================================
// META WEBHOOK ROUTES
// ============================================================================

// 1. Verification Challenge (GET /webhook)
app.get('/webhook', (c) => handleWebhookChallenge(c));

// 2. Incoming Event Ingestion (POST /webhook)
app.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('x-hub-signature-256');

  const result = await processMetaWebhook(rawBody, signature, c.env, c.executionCtx);
  return c.text(result.message, result.status as any);
});

// ============================================================================
// CLOUDFLARE WORKERS HANDLERS (Fetch, Queues, Scheduled Cron)
// ============================================================================
export default {
  // HTTP fetch handler via Hono
  fetch: app.fetch,

  // Queue consumer for asynchronous message processing & agent tool calls
  async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      console.log(`[Queue] Processing message ID: ${message.id}`);
      // Future: Person 1 Agent queue consumer
      message.ack();
    }
  },

  // Scheduled handler for WhatsApp reminders & calendar reconciliation (Cron Triggers)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Scheduled] Cron trigger executed at ${new Date(event.scheduledTime).toISOString()}`);
    // Future: Person 2 Reminder scheduler
  },
};
