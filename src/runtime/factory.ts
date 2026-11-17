import { D1BookingService } from '../bookings/service.js';
import { GoogleCalendarClient } from '../calendar/client.js';
import { MetaWhatsAppTemplateSender, MetaTextSender } from '../channels/outbound.js';
import { D1ConversationStore } from '../llm-integration/conversations/d1-store.js';
import { createAgentProcessor } from '../llm-integration/runtime/create-processor.js';
import { D1NotificationScheduler, D1NotificationStatusHandler } from '../notifications/scheduler.js';
import type { Env } from '../types/env.js';
import { reminderEnvironment, routedEnvironment } from '../accounts/runtime.js';
import { DIRECT_CHAT_ACCOUNT } from '../llm-integration/runtime/direct-chat.js';
import { reconcileCalendarSlots } from '../calendar/reconcile.js';
import { AccountStore } from '../accounts/store.js';

export function createServices(env: Env) {
  // Test fakes belong in tests. Missing production bindings must not simulate bookings.
  if (!env.DB) throw new Error('D1 binding DB is required');
  const calendarForId = (calendarId: string) => calendarId && env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY
    ? new GoogleCalendarClient({
      calendarId,
      clientEmail: env.GOOGLE_CLIENT_EMAIL,
      privateKey: env.GOOGLE_PRIVATE_KEY,
    }) : null;
  const calendarClient = env.GOOGLE_CALENDAR_ID ? calendarForId(env.GOOGLE_CALENDAR_ID) : null;
  const store = new D1ConversationStore(env.DB);
  const bookings = new D1BookingService(env.DB, calendarClient, undefined, { calendarForId, distribuidoraId: 'dwc' });
  const templateSender = new MetaWhatsAppTemplateSender(env);
  return {
    calendarClient, calendarForId, store, bookings, templateSender, textSender: new MetaTextSender(env),
    // Delivery receipts and cron processing do not need an OpenAI key.
    get processor() {
      const legacy = createAgentProcessor(env, store, bookings);
      return async (message: import('../../model.js').InboundMessage) => {
        let routeIdentity = message.identity;
        if (message.operatorTestAccountId) {
          if (message.identity.businessAccountId !== DIRECT_CHAT_ACCOUNT) throw new Error('Operator routing target is only allowed in the protected direct-chat namespace');
          const target = await env.DB!.prepare("SELECT platform,provider_account_id FROM social_accounts WHERE id=? AND platform IN ('instagram','whatsapp')")
            .bind(message.operatorTestAccountId).first<{ platform: 'instagram' | 'whatsapp'; provider_account_id: string }>();
          if (!target) throw new Error('Registered test target required');
          routeIdentity = { ...message.identity, channel: target.platform, businessAccountId: target.provider_account_id };
        } else if (env.MULTI_ACCOUNT_ENABLED !== 'true' || message.identity.businessAccountId === DIRECT_CHAT_ACCOUNT) return legacy(message);
        const scoped = await routedEnvironment(env, routeIdentity);
        if (!scoped) throw new Error('Receiving account is unavailable; reconnect before retrying');
        const service = new D1BookingService(env.DB!, calendarForId(scoped.route.distribuidora.google_calendar_id!), undefined, {
          calendarForId, distribuidoraId: scoped.route.distribuidora.id, socialAccountId: scoped.route.account.id,
          originChannel: message.operatorTestAccountId ? 'operator_test' : message.identity.channel, originHandle: scoped.route.account.handle,
        });
        return createAgentProcessor(scoped.env, store, service)(message);
      };
    },
    scheduler: { processDueNotifications: async (now?: string) => {
      const scoped = env.MULTI_ACCOUNT_ENABLED === 'true' ? await reminderEnvironment(env) : env;
      if (!scoped) throw new Error('Select a connected gym WhatsApp reminder sender');
      return new D1NotificationScheduler(env.DB!, new MetaWhatsAppTemplateSender(scoped), calendarClient, {
        businessAccountId: scoped.META_WHATSAPP_PHONE_NUMBER_ID ?? '',
        confirmationTemplate: env.WHATSAPP_CONFIRMATION_TEMPLATE ?? '', reminderTemplate: env.WHATSAPP_REMINDER_TEMPLATE ?? '',
        includeSource: env.WHATSAPP_ATTRIBUTION_TEMPLATES === 'true',
      }, calendarForId).processDueNotifications(now);
    } },
    reconcileCalendars: async (now: string) => {
      if (env.MULTI_ACCOUNT_ENABLED !== 'true') { if (calendarClient) await reconcileCalendarSlots(env.DB!, calendarClient, now); return; }
      const settings = new AccountStore(env.DB!);
      const cursor = await settings.setting('calendar_scan_cursor') ?? '';
      const rows = await env.DB!.prepare(`SELECT DISTINCT calendar_id FROM bookings WHERE calendar_id>? AND status IN ('pending','confirmed') AND ends_at>? ORDER BY calendar_id LIMIT 10`)
        .bind(cursor, now).all<{ calendar_id: string }>();
      for (const row of rows.results) {
        const calendar = calendarForId(row.calendar_id);
        if (calendar) await reconcileCalendarSlots(env.DB!, calendar, now);
        await settings.setSetting('calendar_scan_cursor', row.calendar_id);
      }
      if (!rows.results.length) await settings.setSetting('calendar_scan_cursor', '');
    },
    statusHandler: new D1NotificationStatusHandler(env.DB),
  };
}
