import { Hono } from 'hono';
import { createWebhookRoutes } from './llm-integration/webhooks/routes.js';
import { createDirectChatRoutes } from './llm-integration/webhooks/direct-chat.js';
import { handleQueue } from './llm-integration/runtime/queue.js';
import type { Env } from './types/env.js';
import { handleScheduled } from './runtime/scheduled.js';
import { createPrivacyRoutes } from './public/privacy.js';

// Initialize Hono with Cloudflare Workers environment bindings
const app = new Hono<{ Bindings: Env }>();

// ============================================================================
// HEALTH CHECK
// ============================================================================
app.get('/', (c) => c.text('First-Class Booking Agent (Cloudflare Worker) is running! 🚀'));
app.route('/', createPrivacyRoutes());

// ============================================================================
// META WEBHOOK ROUTES
// ============================================================================

app.route('/webhook', createWebhookRoutes());
app.route('/test/chat', createDirectChatRoutes());

// ============================================================================
// CLOUDFLARE WORKERS HANDLERS (Fetch, Queues, Scheduled Cron)
// ============================================================================
export default {
  // HTTP fetch handler via Hono
  fetch: app.fetch,

  // Queue consumer for asynchronous message processing & agent tool calls
  queue: handleQueue,

  // Scheduled handler for WhatsApp reminders & calendar reconciliation (Cron Triggers)
  scheduled: handleScheduled,
};
