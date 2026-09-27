import {
  type BookingContext, type BookingMutationContext, type BookingResult, type BookingService,
  type BookTrialInput, type CancelTrialInput, type ClassSchedule, GYM_TIME_ZONE,
  type RescheduleTrialInput, type TrialBooking,
} from '../../model.js';
import type { RosterCalendar } from '../calendar/client.js';
import { syncSlotRoster, type ProspectSlotEntry } from '../calendar/slot-roster.js';
import { AUTHORITATIVE_SCHEDULE, validateBookingSlot } from '../gym/schedule.js';

type Action = 'book' | 'reschedule' | 'cancel';
type MutationInput = BookTrialInput | RescheduleTrialInput | CancelTrialInput;
interface Operation {
  customer_id: string;
  operation_key: string;
  action: Action;
  argument_fingerprint: string;
  booking_id: string;
  status: 'pending' | 'succeeded';
  result_json: string;
  affected_slots: string;
}
const failed = (code: Extract<BookingResult, { status: 'failed' }>['code'], message: string, retryable = false): BookingResult =>
  ({ status: 'failed', code, message, retryable });
const pending = (operation: Operation): BookingResult =>
  ({ status: 'pending', bookingId: operation.booking_id, operationKey: operation.operation_key });

export class D1BookingService implements BookingService {
  constructor(
    private readonly db: D1Database,
    private readonly calendar: RosterCalendar | null,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async getClassSchedule(): Promise<ClassSchedule> { return AUTHORITATIVE_SCHEDULE; }

  async getBooking(context: BookingContext, bookingId: string): Promise<TrialBooking | null> {
    return this.loadBooking(context.customerId, bookingId);
  }

  private async loadBooking(customerId: string, bookingId: string): Promise<TrialBooking | null> {
    const row = await this.db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?')
      .bind(bookingId, customerId).first<{
        id: string; customer_id: string; starts_at: string; ends_at: string; status: TrialBooking['status'];
        revision: number; calendar_id: string | null; event_id: string | null; calendar_etag: string | null;
        created_at: string; updated_at: string;
      }>();
    return row ? {
      id: row.id, customerId: row.customer_id, startsAt: row.starts_at, endsAt: row.ends_at,
      timeZone: GYM_TIME_ZONE, status: row.status, revision: row.revision,
      calendar: row.calendar_id && row.event_id ? { calendarId: row.calendar_id, eventId: row.event_id, etag: row.calendar_etag } : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  bookTrial(context: BookingMutationContext, input: BookTrialInput): Promise<BookingResult> {
    return this.mutate(context, 'book', input);
  }
  rescheduleTrial(context: BookingMutationContext, input: RescheduleTrialInput): Promise<BookingResult> {
    return this.mutate(context, 'reschedule', input);
  }
  cancelTrial(context: BookingMutationContext, input: CancelTrialInput): Promise<BookingResult> {
    return this.mutate(context, 'cancel', input);
  }

  private operation(customerId: string, key: string): Promise<Operation | null> {
    return this.db.prepare('SELECT * FROM booking_operations WHERE customer_id = ? AND operation_key = ?')
      .bind(customerId, key).first<Operation>();
  }

  private async replay(operation: Operation, action: Action, fingerprint: string): Promise<BookingResult> {
    if (operation.action !== action || operation.argument_fingerprint !== fingerprint) {
      return failed('idempotency_conflict', 'Operation key was used for different arguments.');
    }
    return operation.status === 'succeeded' ? JSON.parse(operation.result_json) : this.synchronize(operation);
  }

  private async mutate(context: BookingMutationContext, action: Action, input: MutationInput): Promise<BookingResult> {
    const fingerprint = JSON.stringify(action === 'book' ? { startsAt: (input as BookTrialInput).startsAt }
      : action === 'cancel' ? { bookingId: (input as CancelTrialInput).bookingId, expectedRevision: (input as CancelTrialInput).expectedRevision }
        : { bookingId: (input as RescheduleTrialInput).bookingId, startsAt: (input as RescheduleTrialInput).startsAt, expectedRevision: (input as RescheduleTrialInput).expectedRevision });
    const prior = await this.operation(context.customerId, context.operationKey);
    if (prior) return this.replay(prior, action, fingerprint);
    if (!this.calendar) return failed('dependency_unavailable', 'Google Calendar is not configured.', true);

    const now = context.requestedAt;
    const existing = action === 'book' ? null : await this.loadBooking(context.customerId, (input as CancelTrialInput).bookingId);
    if (action !== 'book') {
      if (!existing) return failed('not_found', 'Booking not found.');
      if (existing.revision !== (input as CancelTrialInput).expectedRevision || existing.status !== 'confirmed') {
        return failed('revision_conflict', 'Only the current confirmed booking can be changed.');
      }
      if (existing.calendar?.calendarId !== this.calendar.configuredCalendarId) {
        return failed('dependency_unavailable', 'The booking belongs to another calendar.');
      }
    }
    const slot = action === 'cancel' ? null : validateBookingSlot((input as BookTrialInput).startsAt, now);
    if (slot && (!slot.valid || !slot.startsAtUtc || !slot.endsAtUtc)) return failed('invalid_schedule', slot.reason ?? 'Invalid class time.');
    const startsAt = slot?.startsAtUtc ?? existing!.startsAt;
    const endsAt = slot?.endsAtUtc ?? existing!.endsAt;

    const customer = await this.db.prepare('SELECT name, whatsapp_phone, instagram_handle FROM customers WHERE id = ?')
      .bind(context.customerId).first<{ name: string | null; whatsapp_phone: string | null; instagram_handle: string | null }>();
    if (action !== 'cancel' && (!customer?.name?.trim()
      || !(/^\+[1-9]\d{7,14}$/.test(customer.whatsapp_phone ?? '') || /^@?[a-zA-Z0-9._]{1,30}$/.test(customer.instagram_handle ?? '')))) {
      return failed('missing_customer_details', 'Name and a valid phone number or Instagram handle are required.');
    }

    const bookingId = existing?.id ?? `trial_${crypto.randomUUID()}`;
    const slots = [...new Set([...(existing ? [existing.startsAt] : []), startsAt])].sort();
    const operation: Operation = {
      customer_id: context.customerId, operation_key: context.operationKey, action,
      argument_fingerprint: fingerprint, booking_id: bookingId, status: 'pending', result_json: '', affected_slots: JSON.stringify(slots),
    };
    const statements: D1PreparedStatement[] = [];
    if (action === 'book') {
      statements.push(this.db.prepare(
        `INSERT INTO bookings (id, customer_id, starts_at, ends_at, time_zone, status, revision, calendar_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?)`
      ).bind(bookingId, context.customerId, startsAt, endsAt, GYM_TIME_ZONE, this.calendar.configuredCalendarId, now, now));
    }
    // Claim before updating an existing booking. The partial unique index blocks a
    // competing mutation for this customer, including another create during cancellation.
    statements.push(this.db.prepare(
      `INSERT INTO booking_operations (customer_id, operation_key, action, argument_fingerprint, booking_id, status, result_json, affected_slots, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).bind(context.customerId, context.operationKey, action, fingerprint, bookingId, JSON.stringify(pending(operation)), operation.affected_slots, now, now));
    if (existing) {
      // A revision mismatch aborts the entire batch through NOT NULL, rather than
      // committing an operation whose requested mutation was never applied.
      statements.push(this.db.prepare(
        `UPDATE bookings SET starts_at = ?, ends_at = ?, status = ?,
         revision = CASE WHEN revision = ? AND status = 'confirmed' THEN revision + 1 ELSE NULL END,
         event_id = CASE WHEN starts_at = ? THEN event_id ELSE NULL END,
         calendar_etag = NULL, updated_at = ? WHERE id = ? AND customer_id = ?`
      ).bind(startsAt, endsAt, action === 'cancel' ? 'cancelled' : 'confirmed', existing.revision, startsAt, now, bookingId, context.customerId));
      statements.push(this.db.prepare("UPDATE notification_jobs SET state = 'cancelled', updated_at = ? WHERE booking_id = ? AND state IN ('pending', 'leased')")
        .bind(now, bookingId));
    }
    try { await this.db.batch(statements); }
    catch (error) {
      const raced = await this.operation(context.customerId, context.operationKey);
      if (raced) return this.replay(raced, action, fingerprint);
      const active = await this.db.prepare("SELECT id FROM bookings WHERE customer_id = ? AND status IN ('pending', 'confirmed')")
        .bind(context.customerId).first();
      if (action === 'book' && active) return failed('already_booked', 'An active trial already exists.');
      if (existing || await this.db.prepare("SELECT operation_key FROM booking_operations WHERE customer_id = ? AND status = 'pending'").bind(context.customerId).first()) {
        return failed('revision_conflict', 'Another booking change is in progress.', true);
      }
      throw error;
    }
    return this.synchronize(operation);
  }

  private async synchronize(operation: Operation): Promise<BookingResult> {
    if (!this.calendar) return pending(operation);
    const token = crypto.randomUUID();
    const now = this.clock();
    const claimed = await this.db.prepare(
      `UPDATE booking_operations SET lease_token = ?, lease_expires_at = ?
       WHERE customer_id = ? AND operation_key = ? AND status = 'pending'
       AND (lease_token IS NULL OR lease_expires_at < ?)`
    ).bind(token, new Date(Date.parse(now) + 10 * 60_000).toISOString(), operation.customer_id, operation.operation_key, now).run();
    if (!claimed.meta.changes) {
      const current = await this.operation(operation.customer_id, operation.operation_key);
      return current?.status === 'succeeded' ? JSON.parse(current.result_json) : pending(operation);
    }
    try {
      const calendarId = this.calendar.configuredCalendarId;
      for (const startsAt of JSON.parse(operation.affected_slots) as string[]) {
        const renewedAt = this.clock();
        const renewed = await this.db.prepare(
          `UPDATE booking_operations SET lease_expires_at = ? WHERE customer_id = ? AND operation_key = ?
           AND status = 'pending' AND lease_token = ? AND lease_expires_at > ?`
        ).bind(new Date(Date.parse(renewedAt) + 10 * 60_000).toISOString(), operation.customer_id, operation.operation_key, token, renewedAt).run();
        if (!renewed.meta.changes) throw new Error('Booking synchronization lease expired');
        const event = await syncSlotRoster(this.calendar, startsAt, async () => {
          const rows = await this.db.prepare(
            `SELECT b.id AS bookingId, c.name, c.whatsapp_phone AS phone, c.instagram_handle AS instagramHandle, c.language
             FROM bookings b JOIN customers c ON c.id = b.customer_id
             WHERE b.calendar_id = ? AND b.starts_at = ? AND b.status IN ('pending', 'confirmed') ORDER BY b.id`
          ).bind(calendarId, startsAt).all<ProspectSlotEntry>();
          return rows.results;
        });
        await this.db.prepare('UPDATE bookings SET event_id = ?, calendar_etag = ? WHERE calendar_id = ? AND starts_at = ?')
          .bind(event.id, event.etag, calendarId, startsAt).run();
      }
      const booking = await this.loadBooking(operation.customer_id, operation.booking_id);
      if (!booking) throw new Error('Pending booking disappeared');
      if (booking.status === 'pending') booking.status = 'confirmed';
      const result: BookingResult = { status: 'succeeded', booking };
      const timestamp = this.clock();
      booking.updatedAt = timestamp;
      const statements = [
        // Fence expired workers before changing bookings or creating notifications.
        // The NOT NULL constraint aborts the entire D1 batch if ownership was lost.
        this.db.prepare(`UPDATE booking_operations SET result_json = CASE
          WHEN status = 'pending' AND lease_token = ? AND lease_expires_at > ? THEN result_json ELSE NULL END
          WHERE customer_id = ? AND operation_key = ?`)
          .bind(token, timestamp, operation.customer_id, operation.operation_key),
        this.db.prepare("UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?").bind(booking.status, timestamp, booking.id),
        this.db.prepare("UPDATE booking_operations SET status = 'succeeded', result_json = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE customer_id = ? AND operation_key = ? AND lease_token = ?")
          .bind(JSON.stringify(result), timestamp, operation.customer_id, operation.operation_key, token),
      ];
      // Notification jobs stay per prospect, not per shared Calendar event.
      if (booking.status === 'confirmed') {
        const reminderAt = new Date(Math.max(Date.parse(booking.startsAt) - 24 * 60 * 60_000, Date.parse(timestamp))).toISOString();
        for (const [kind, due] of [['confirmation', timestamp], ['reminder', reminderAt]]) {
          statements.push(this.db.prepare(
            `INSERT INTO notification_jobs (id, booking_id, booking_revision, kind, scheduled_at, state, created_at, updated_at)
             SELECT ?, b.id, b.revision, ?, ?, 'pending', ?, ? FROM bookings b JOIN customers c ON c.id = b.customer_id
             WHERE b.id = ? AND b.starts_at > ? AND EXISTS (
               SELECT 1 FROM consents co WHERE co.customer_id = c.id AND co.phone = c.whatsapp_phone
               AND co.purpose = 'trial_confirmation_and_reminders' AND co.revoked_at IS NULL
               AND co.id = (SELECT id FROM consents WHERE customer_id = c.id ORDER BY granted_at DESC, rowid DESC LIMIT 1))
             ON CONFLICT(booking_id, booking_revision, kind) DO NOTHING`
          ).bind(`job_${crypto.randomUUID()}`, kind, due, timestamp, timestamp, booking.id, timestamp));
        }
      }
      await this.db.batch(statements);
      return result;
    } catch {
      // Durable desired roster remains in D1. Same operation (or cron) will rebuild
      // affected slots; no new booking ID and no blind re-append of a prospect.
      await this.db.prepare('UPDATE booking_operations SET lease_token = NULL, lease_expires_at = NULL WHERE customer_id = ? AND operation_key = ? AND lease_token = ?')
        .bind(operation.customer_id, operation.operation_key, token).run();
      return pending(operation);
    }
  }

  async reconcilePendingOperations(limit = 20): Promise<void> {
    const rows = await this.db.prepare("SELECT * FROM booking_operations WHERE status = 'pending' ORDER BY created_at LIMIT ?")
      .bind(limit).all<Operation>();
    for (const operation of rows.results) await this.synchronize(operation);
  }
}
