import { GYM_TIME_ZONE, type NotificationDeliveryUpdate, type NotificationStatusHandler, type WhatsAppTemplateSender } from '../../model.js';
import type { RosterCalendar } from '../calendar/client.js';
import { inspectCalendarSlot } from '../calendar/reconcile.js';
import { claimDelivery, recordDelivery, recoverDeliveries, type DeliveryTable } from '../llm-integration/runtime/delivery.js';
import { alert, later, resolveAlert } from '../llm-integration/runtime/persistence.js';

export class D1NotificationScheduler {
  constructor(private readonly db: D1Database, private readonly sender: WhatsAppTemplateSender,
    private readonly calendar: RosterCalendar | null,
    private readonly config: { businessAccountId: string; confirmationTemplate: string; reminderTemplate: string }) {}

  async processDueNotifications(now = new Date().toISOString()): Promise<number> {
    await recoverDeliveries(this.db, 'notification_jobs', now);
    const due = await this.db.prepare(`SELECT id FROM notification_jobs WHERE state = 'pending'
      AND scheduled_at <= ? AND (available_at IS NULL OR available_at <= ?) ORDER BY scheduled_at LIMIT 20`).bind(now, now).all<{ id: string }>();
    let sent = 0;
    for (const { id } of due.results) {
      const token = await claimDelivery(this.db, 'notification_jobs', id, now);
      if (!token) continue;
      const job = await this.db.prepare(`SELECT j.booking_id, j.booking_revision, j.kind, b.revision, b.status, b.starts_at,
        b.event_id, c.name, c.language, c.whatsapp_phone,
        EXISTS(SELECT 1 FROM booking_operations WHERE booking_id = b.id AND status = 'pending') AS syncing,
        EXISTS(SELECT 1 FROM consents co WHERE co.customer_id = c.id AND co.phone = c.whatsapp_phone
          AND co.purpose = 'trial_confirmation_and_reminders' AND co.revoked_at IS NULL
          AND co.id = (SELECT id FROM consents WHERE customer_id = c.id ORDER BY granted_at DESC, rowid DESC LIMIT 1)) AS consent
        FROM notification_jobs j JOIN bookings b ON b.id = j.booking_id JOIN customers c ON c.id = b.customer_id WHERE j.id = ?`)
        .bind(id).first<{ booking_id: string; booking_revision: number; kind: string; revision: number; status: string; starts_at: string;
          event_id: string; name: string; language: string; whatsapp_phone: string | null; syncing: number; consent: number }>();
      if (!job || job.status !== 'confirmed' || job.booking_revision !== job.revision || job.starts_at <= now || !job.whatsapp_phone || !job.consent) {
        await this.db.prepare("UPDATE notification_jobs SET state = 'cancelled', lease_token = NULL WHERE id = ? AND lease_token = ?").bind(id, token).run();
        continue;
      }
      if (job.syncing || !this.calendar || !await inspectCalendarSlot(this.db, this.calendar, job.starts_at, job.event_id, now)) {
        await this.db.prepare("UPDATE notification_jobs SET state = 'pending', available_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?")
          .bind(later(now, 300), id, token).run();
        continue;
      }
      // Atomic handoff: cancellation either cancels a leased job before this point,
      // or sees 'sending' and returns retryable rather than claiming it cancelled a send.
      const marked = await this.db.prepare(`UPDATE notification_jobs SET state = 'sending', attempts = attempts + 1, business_account_id = ?
        WHERE id = ? AND lease_token = ? AND state = 'leased' AND EXISTS (
          SELECT 1 FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = notification_jobs.booking_id
          AND b.status = 'confirmed' AND b.revision = notification_jobs.booking_revision AND c.whatsapp_phone = ?
          AND NOT EXISTS(SELECT 1 FROM booking_operations WHERE booking_id = b.id AND status = 'pending')
          AND EXISTS(SELECT 1 FROM consents co WHERE co.customer_id = c.id AND co.phone = c.whatsapp_phone AND co.revoked_at IS NULL
            AND co.id = (SELECT id FROM consents WHERE customer_id = c.id ORDER BY granted_at DESC, rowid DESC LIMIT 1)))`)
        .bind(this.config.businessAccountId, id, token, job.whatsapp_phone).run();
      if (!marked.meta.changes) continue;
      const locale = job.language === 'en' ? 'en-US' : 'es-US';
      const date = new Intl.DateTimeFormat(locale, { timeZone: GYM_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(job.starts_at));
      const time = new Intl.DateTimeFormat(locale, { timeZone: GYM_TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(job.starts_at));
      let result;
      try { result = await this.sender.sendTemplate({ notificationJobId: id, to: job.whatsapp_phone,
        templateName: job.kind === 'confirmation' ? this.config.confirmationTemplate : this.config.reminderTemplate,
        languageCode: job.language === 'en' ? 'en_US' : 'es', bodyParameters: [job.name, date, time] }); }
      catch { result = { status: 'unknown' as const, reason: 'sender_interrupted' }; }
      await recordDelivery(this.db, 'notification_jobs', id, token, result, now);
      if (result.status === 'accepted') sent++;
    }
    return sent;
  }
}

/** Store receipts even before the send result, deduplicate them, then derive monotonic delivery. */
export class D1NotificationStatusHandler implements NotificationStatusHandler {
  constructor(private readonly db: D1Database) {}
  async handleDeliveryUpdate(update: NotificationDeliveryUpdate): Promise<void> {
    await this.db.prepare(`INSERT INTO notification_delivery_events
      (id, business_account_id, provider_message_id, status, occurred_at, error_code, received_at, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(business_account_id, provider_message_id, status, occurred_at) DO NOTHING`)
      .bind(crypto.randomUUID(), update.businessAccountId, update.providerMessageId, update.status, update.occurredAt,
        update.errorCode ?? null, new Date().toISOString(), update.correlationId ?? null).run();
    await this.reconcile(update.businessAccountId, update.providerMessageId, update.correlationId);
  }

  private async reconcile(account: string, message: string, correlation?: string) {
    const summary = await this.db.prepare(`SELECT max(CASE status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END) AS rank,
      max(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, max(occurred_at) AS occurred
      FROM notification_delivery_events WHERE business_account_id = ? AND provider_message_id = ?`).bind(account, message)
      .first<{ rank: number; failed: number; occurred: string }>();
    if (!summary) return;
    const delivery = summary.rank === 3 ? 'read' : summary.rank === 2 ? 'delivered' : summary.failed ? 'failed' : 'sent';
    let matched = false;
    for (const table of ['notification_jobs', 'outgoing_messages'] as DeliveryTable[]) {
      const result = await this.db.prepare(`UPDATE ${table} SET provider_message_id = ?, delivery_status = ?, delivery_at = ?,
        state = ?, lease_token = NULL, lease_expires_at = NULL WHERE business_account_id = ?
        AND (provider_message_id = ? OR (id = ? AND state IN ('sending','unknown','accepted','failed'))) RETURNING id`)
        .bind(message, delivery, summary.occurred, delivery === 'failed' ? 'failed' : 'accepted', account, message, correlation ?? '').all<{ id: string }>();
      matched ||= result.results.length > 0;
      for (const row of result.results) {
        await resolveAlert(this.db, 'delivery_unknown', row.id);
        if (summary.rank >= 2) await resolveAlert(this.db, 'delivery_failed', row.id);
      }
      if (result.results.length && delivery === 'failed') await alert(this.db, 'provider_delivery_failed', message, 'Provider reported delivery failure');
    }
    if (matched) await this.db.prepare('UPDATE notification_delivery_events SET reconciled_at = ? WHERE business_account_id = ? AND provider_message_id = ?')
      .bind(new Date().toISOString(), account, message).run();
    if (matched && summary.rank >= 2) await resolveAlert(this.db, 'provider_delivery_failed', message);
  }

  async reconcileStoredReceipts() {
    const rows = await this.db.prepare(`SELECT e.business_account_id, e.provider_message_id, max(e.correlation_id) AS correlation_id
      FROM notification_delivery_events e WHERE e.reconciled_at IS NULL AND (
        EXISTS(SELECT 1 FROM notification_jobs j WHERE j.business_account_id = e.business_account_id AND (j.provider_message_id = e.provider_message_id OR j.id = e.correlation_id))
        OR EXISTS(SELECT 1 FROM outgoing_messages o WHERE o.business_account_id = e.business_account_id AND (o.provider_message_id = e.provider_message_id OR o.id = e.correlation_id)))
      GROUP BY e.business_account_id, e.provider_message_id ORDER BY min(e.received_at) LIMIT 100`)
      .all<{ business_account_id: string; provider_message_id: string; correlation_id: string | null }>();
    for (const row of rows.results) await this.reconcile(row.business_account_id, row.provider_message_id, row.correlation_id ?? undefined);
  }
}
