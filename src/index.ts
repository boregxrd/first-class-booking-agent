import { Hono } from 'hono';
import { createWebhookRoutes } from './llm-integration/webhooks/routes.js';
import { handleQueue } from './llm-integration/runtime/queue.js';
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

app.route('/webhook', createWebhookRoutes());

import { createServices } from './runtime/factory.js';

// ============================================================================
// CLOUDFLARE WORKERS HANDLERS (Fetch, Queues, Scheduled Cron)
// ============================================================================
export default {
  // HTTP fetch handler via Hono
  fetch: app.fetch,

  // Queue consumer for asynchronous message processing & agent tool calls
  queue: handleQueue,

  // Scheduled handler for WhatsApp reminders & calendar reconciliation (Cron Triggers)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Scheduled] Cron trigger executed at ${new Date(event.scheduledTime).toISOString()}`);
    const services = createServices(env);
    if (services.scheduler) {
      const processed = await services.scheduler.processDueNotifications(new Date(event.scheduledTime).toISOString());
      console.log(`[Scheduled] Processed ${processed} due notifications.`);
    }
  },
};
