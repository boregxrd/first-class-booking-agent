import { D1BookingService } from '../bookings/service.js';
import { GoogleCalendarClient } from '../calendar/client.js';
import { MetaWhatsAppTemplateSender } from '../channels/outbound.js';
import { D1ConversationStore } from '../llm-integration/conversations/d1-store.js';
import { createAgentProcessor } from '../llm-integration/runtime/create-processor.js';
import { D1NotificationScheduler, D1NotificationStatusHandler } from '../notifications/scheduler.js';
import type { Env } from '../types/env.js';

export function createServices(env: Env) {
  // Test fakes belong in tests. Missing production bindings must not simulate bookings.
  if (!env.DB) throw new Error('D1 binding DB is required');
  const calendarClient = env.GOOGLE_CALENDAR_ID && env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY
    ? new GoogleCalendarClient({
      calendarId: env.GOOGLE_CALENDAR_ID,
      clientEmail: env.GOOGLE_CLIENT_EMAIL,
      privateKey: env.GOOGLE_PRIVATE_KEY,
    }) : null;
  const store = new D1ConversationStore(env.DB);
  const bookings = new D1BookingService(env.DB, calendarClient);
  const templateSender = new MetaWhatsAppTemplateSender(env);
  return {
    calendarClient, store, bookings, templateSender,
    // Delivery receipts and cron processing do not need an OpenAI key.
    get processor() { return createAgentProcessor(env, store, bookings); },
    scheduler: new D1NotificationScheduler(env.DB, templateSender),
    statusHandler: new D1NotificationStatusHandler(env.DB),
  };
}
