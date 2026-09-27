import {
  GYM_TIME_ZONE,
  NotificationDeliveryUpdate,
  NotificationStatusHandler,
  WhatsAppTemplateRequest,
  WhatsAppTemplateSender,
} from '../../model.js';

export class D1NotificationScheduler {
  constructor(
    private db: D1Database,
    private templateSender: WhatsAppTemplateSender
  ) {}

  /**
   * Scans D1 for due notification jobs, verifies booking status/consent, and dispatches templates.
   */
  async processDueNotifications(nowInstant: string = new Date().toISOString()): Promise<number> {
    const leaseToken = crypto.randomUUID();
    const leaseExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min lease

    // 1. Find due jobs
    const dueJobs = await this.db
      .prepare(
        `SELECT j.id, j.booking_id, j.booking_revision, j.kind, j.scheduled_at,
                b.starts_at, b.status as booking_status,
                c.id as customer_id, c.name as customer_name, c.whatsapp_phone, c.language
         FROM notification_jobs j
         JOIN bookings b ON j.booking_id = b.id
         JOIN customers c ON b.customer_id = c.id
         WHERE j.state = 'pending' AND j.scheduled_at <= ?
         LIMIT 20`
      )
      .bind(nowInstant)
      .all<{
        id: string;
        booking_id: string;
        booking_revision: number;
        kind: 'confirmation' | 'reminder';
        scheduled_at: string;
        starts_at: string;
        booking_status: string;
        customer_id: string;
        customer_name: string | null;
        whatsapp_phone: string | null;
        language: string;
      }>();

    const jobs = dueJobs.results || [];
    if (jobs.length === 0) return 0;

    let processedCount = 0;

    for (const job of jobs) {
      // Lease job atomically
      const leaseResult = await this.db
        .prepare(
          `UPDATE notification_jobs
           SET state = 'leased', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND state = 'pending'`
        )
        .bind(leaseToken, leaseExpiry, nowInstant, job.id)
        .run();

      if (!leaseResult.meta.changes) continue;

      // Skip if booking was cancelled/elapsed or customer has no WhatsApp phone
      if (job.booking_status !== 'confirmed' || !job.whatsapp_phone) {
        await this.db
          .prepare(`UPDATE notification_jobs SET state = 'cancelled', updated_at = ? WHERE id = ?`)
          .bind(nowInstant, job.id)
          .run();
        continue;
      }

      // Format date and time in America/Chicago
      const startDate = new Date(job.starts_at);
      const dateFormatter = new Intl.DateTimeFormat('es-US', {
        timeZone: GYM_TIME_ZONE,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
      const timeFormatter = new Intl.DateTimeFormat('es-US', {
        timeZone: GYM_TIME_ZONE,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });

      const formattedDate = dateFormatter.format(startDate);
      const formattedTime = timeFormatter.format(startDate);
      const customerName = job.customer_name || 'hermosa';

      const templateName = job.kind === 'confirmation' ? 'trial_booking_confirmation' : 'trial_class_reminder';
      const templateReq: WhatsAppTemplateRequest = {
        notificationJobId: job.id,
        to: job.whatsapp_phone,
        templateName,
        languageCode: job.language === 'en' ? 'en_US' : 'es',
        bodyParameters: [customerName, formattedDate, formattedTime],
      };

      const sendResult = await this.templateSender.sendTemplate(templateReq);

      if (sendResult.status === 'accepted') {
        await this.db
          .prepare(
            `UPDATE notification_jobs
             SET state = 'accepted', provider_message_id = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(sendResult.providerMessageId, nowInstant, job.id)
          .run();
        processedCount++;
      } else if (sendResult.status === 'rejected') {
        const nextState = sendResult.retryable ? 'pending' : 'failed';
        await this.db
          .prepare(
            `UPDATE notification_jobs
             SET state = ?, last_error_code = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(nextState, sendResult.code, nowInstant, job.id)
          .run();
      } else {
        // Unknown status -> maintain lease record but do not aggressively retry
        await this.db
          .prepare(
            `UPDATE notification_jobs
             SET state = 'unknown', last_error_code = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(sendResult.reason, nowInstant, job.id)
          .run();
      }
    }

    return processedCount;
  }
}

export class D1NotificationStatusHandler implements NotificationStatusHandler {
  constructor(private db: D1Database) {}

  async handleDeliveryUpdate(update: NotificationDeliveryUpdate): Promise<void> {
    const id = `deliv_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO notification_delivery_events (id, business_account_id, provider_message_id, status, occurred_at, error_code, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          update.businessAccountId,
          update.providerMessageId,
          update.status,
          update.occurredAt,
          update.errorCode || null,
          now
        ),
      // Update notification_job status if delivered/read/failed
      this.db
        .prepare(
          `UPDATE notification_jobs
           SET state = CASE WHEN ? = 'failed' THEN 'failed' ELSE state END,
               updated_at = ?
           WHERE provider_message_id = ?`
        )
        .bind(update.status, now, update.providerMessageId),
    ]);
  }
}
