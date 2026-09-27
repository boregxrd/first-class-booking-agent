import { D1BookingService } from '../bookings/service.js';
import { GoogleCalendarClient } from '../calendar/client.js';
import { MetaWhatsAppTemplateSender } from '../channels/outbound.js';
import { D1ConversationStore } from '../llm-integration/conversations/d1-store.js';
import { ConversationSession, ConversationState, ConversationStore } from '../llm-integration/conversations/store.js';
import { createAgentProcessor } from '../llm-integration/runtime/create-processor.js';
import { D1NotificationScheduler, D1NotificationStatusHandler } from '../notifications/scheduler.js';
import { Env } from '../types/env.js';

class MemoryStore implements ConversationStore {
  private stateMap = new Map<string, ConversationState>();
  async withConversation<T>(identity: any, work: (session: ConversationSession) => Promise<T>): Promise<T> {
    const key = `${identity.channel}:${identity.businessAccountId}:${identity.senderId}`;
    if (!this.stateMap.has(key)) {
      this.stateMap.set(key, {
        id: `conv_${crypto.randomUUID()}`,
        customer: { id: `cust_${crypto.randomUUID()}`, name: null, whatsappPhone: null, language: 'es', whatsappConsent: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        history: [],
        proposal: null,
        bookingOperation: null,
      });
    }
    const state = this.stateMap.get(key)!;
    const session: ConversationSession = {
      state,
      async getProcessedTurn() { return null; },
      async save(updated) { Object.assign(state, updated); },
      async complete(msg, finalState, result) {
        Object.assign(state, finalState);
        state.history.push({ role: 'user', content: msg.text });
        state.history.push({ role: 'assistant', content: result.reply });
      },
    };
    return work(session);
  }
}

export function createServices(env: Env) {
  // Calendar Client
  const calendarClient =
    env.GOOGLE_CALENDAR_ID && env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY
      ? new GoogleCalendarClient({
          calendarId: env.GOOGLE_CALENDAR_ID,
          clientEmail: env.GOOGLE_CLIENT_EMAIL,
          privateKey: env.GOOGLE_PRIVATE_KEY,
        })
      : null;

  // D1 Database or In-Memory fallback (useful for local offline testing)
  const store = env.DB ? new D1ConversationStore(env.DB) : new MemoryStore();
  const bookings = env.DB
    ? new D1BookingService(env.DB, calendarClient)
    : ({
        getClassSchedule: async () => ({
          timeZone: 'America/Chicago',
          weekly: [],
          durationMinutes: 60,
          dateOverrides: [],
          minimumLeadMinutes: 60,
          bookingHorizonDays: 14,
        }),
        getBooking: async () => null,
        bookTrial: async () => ({
          status: 'succeeded',
          booking: {
            id: 'trial_mock',
            customerId: 'cust_mock',
            startsAt: new Date().toISOString(),
            endsAt: new Date().toISOString(),
            timeZone: 'America/Chicago',
            status: 'confirmed',
            revision: 1,
            calendar: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
        rescheduleTrial: async () => ({
          status: 'succeeded',
          booking: {
            id: 'trial_mock',
            customerId: 'cust_mock',
            startsAt: new Date().toISOString(),
            endsAt: new Date().toISOString(),
            timeZone: 'America/Chicago',
            status: 'confirmed',
            revision: 2,
            calendar: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
        cancelTrial: async () => ({
          status: 'succeeded',
          booking: {
            id: 'trial_mock',
            customerId: 'cust_mock',
            startsAt: new Date().toISOString(),
            endsAt: new Date().toISOString(),
            timeZone: 'America/Chicago',
            status: 'cancelled',
            revision: 2,
            calendar: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      } as any);

  const processor = createAgentProcessor(env, store, bookings);
  const templateSender = new MetaWhatsAppTemplateSender(env);
  const scheduler = env.DB ? new D1NotificationScheduler(env.DB, templateSender) : null;
  const statusHandler = env.DB ? new D1NotificationStatusHandler(env.DB) : null;

  return {
    calendarClient,
    store,
    bookings,
    processor,
    templateSender,
    scheduler,
    statusHandler,
  };
}
