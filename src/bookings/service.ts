import {
  BookingContext,
  BookingMutationContext,
  BookingResult,
  BookingService,
  BookTrialInput,
  CancelTrialInput,
  ClassSchedule,
  GYM_TIME_ZONE,
  RescheduleTrialInput,
  TrialBooking,
} from '../../model.js';
import { GoogleCalendarClient } from '../calendar/client.js';
import { AUTHORITATIVE_SCHEDULE, validateBookingSlot } from '../gym/schedule.js';

export class D1BookingService implements BookingService {
  constructor(
    private db: D1Database,
    private calendarClient: GoogleCalendarClient | null
  ) {}

  async getClassSchedule(): Promise<ClassSchedule> {
    return AUTHORITATIVE_SCHEDULE;
  }

  async getBooking(context: BookingContext, bookingId: string): Promise<TrialBooking | null> {
    const row = await this.db
      .prepare(
        `SELECT id, customer_id, starts_at, ends_at, time_zone, status, revision, calendar_id, event_id, calendar_etag, created_at, updated_at
         FROM bookings
         WHERE id = ? AND customer_id = ?`
      )
      .bind(bookingId, context.customerId)
      .first<{
        id: string;
        customer_id: string;
        starts_at: string;
        ends_at: string;
        time_zone: string;
        status: 'pending' | 'confirmed' | 'cancelled' | 'elapsed' | 'failed';
        revision: number;
        calendar_id: string | null;
        event_id: string | null;
        calendar_etag: string | null;
        created_at: string;
        updated_at: string;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      customerId: row.customer_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timeZone: GYM_TIME_ZONE,
      status: row.status,
      revision: row.revision,
      calendar: row.calendar_id && row.event_id ? { calendarId: row.calendar_id, eventId: row.event_id, etag: row.calendar_etag } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async bookTrial(context: BookingMutationContext, input: BookTrialInput): Promise<BookingResult> {
    const now = context.requestedAt || new Date().toISOString();

    // 1. Check idempotency: Return existing result if operation key already processed
    const existingOp = await this.db
      .prepare(
        `SELECT result_json
         FROM booking_operations
         WHERE customer_id = ? AND operation_key = ?`
      )
      .bind(context.customerId, context.operationKey)
      .first<{ result_json: string }>();

    if (existingOp?.result_json) {
      return JSON.parse(existingOp.result_json) as BookingResult;
    }

    // 2. Validate schedule time slot
    const validation = validateBookingSlot(input.startsAt, now);
    if (!validation.valid || !validation.startsAtUtc || !validation.endsAtUtc) {
      return {
        status: 'failed',
        code: 'invalid_schedule',
        message: validation.reason || 'Invalid class time requested.',
        retryable: false,
      };
    }

    // 3. Verify single active booking invariant (prevent duplicate active trials)
    const activeBooking = await this.db
      .prepare(
        `SELECT id
         FROM bookings
         WHERE customer_id = ? AND status IN ('pending', 'confirmed')`
      )
      .bind(context.customerId)
      .first<{ id: string }>();

    if (activeBooking) {
      return {
        status: 'failed',
        code: 'already_booked',
        message: 'You already have an active trial booking.',
        retryable: false,
      };
    }

    // 4. Fetch customer details for calendar description and notifications
    const customer = await this.db
      .prepare(`SELECT name, whatsapp_phone, language FROM customers WHERE id = ?`)
      .bind(context.customerId)
      .first<{ name: string | null; whatsapp_phone: string | null; language: 'es' | 'en' }>();

    const bookingId = `trial_${crypto.randomUUID()}`;
    const customerName = customer?.name || 'Prospect';

    // 5. Create Google Calendar Event
    let calendarEventId: string | null = null;
    let calendarEtag: string | null = null;

    if (this.calendarClient) {
      try {
        const calEvent = await this.calendarClient.createTrialEvent({
          bookingId,
          customerName,
          whatsappPhone: customer?.whatsapp_phone,
          language: customer?.language || 'es',
          startsAt: validation.startsAtUtc,
          endsAt: validation.endsAtUtc,
        });
        calendarEventId = calEvent.id;
        calendarEtag = calEvent.etag;
      } catch (err) {
        console.error('[BookingService] Failed to create Google Calendar event:', err);
        return {
          status: 'failed',
          code: 'dependency_unavailable',
          message: 'Could not sync booking with Google Calendar at this moment.',
          retryable: true,
        };
      }
    }

    const booking: TrialBooking = {
      id: bookingId,
      customerId: context.customerId,
      startsAt: validation.startsAtUtc,
      endsAt: validation.endsAtUtc,
      timeZone: GYM_TIME_ZONE,
      status: 'confirmed',
      revision: 1,
      calendar: calendarEventId ? { calendarId: 'primary', eventId: calendarEventId, etag: calendarEtag } : null,
      createdAt: now,
      updatedAt: now,
    };

    const result: BookingResult = {
      status: 'succeeded',
      booking,
    };

    // Calculate reminder time (24 hours before class start, or 2 hours if booked last-minute)
    const classStartTime = new Date(validation.startsAtUtc).getTime();
    const reminderTime = new Date(Math.max(classStartTime - 24 * 60 * 60 * 1000, new Date(now).getTime() + 10 * 60 * 1000)).toISOString();

    const confirmJobId = `job_conf_${crypto.randomUUID()}`;
    const reminderJobId = `job_rem_${crypto.randomUUID()}`;

    // 6. Atomically persist booking, notification jobs, and operation idempotency
    await this.db.batch([
      // Bookings table
      this.db
        .prepare(
          `INSERT INTO bookings (id, customer_id, starts_at, ends_at, time_zone, status, revision, calendar_id, event_id, calendar_etag, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'confirmed', 1, ?, ?, ?, ?, ?)`
        )
        .bind(
          booking.id,
          booking.customerId,
          booking.startsAt,
          booking.endsAt,
          booking.timeZone,
          booking.calendar?.calendarId || null,
          booking.calendar?.eventId || null,
          booking.calendar?.etag || null,
          now,
          now
        ),
      // Immediate WhatsApp Confirmation Job
      this.db
        .prepare(
          `INSERT INTO notification_jobs (id, booking_id, booking_revision, kind, scheduled_at, state, created_at, updated_at)
           VALUES (?, ?, 1, 'confirmation', ?, 'pending', ?, ?)`
        )
        .bind(confirmJobId, booking.id, now, now, now),
      // Scheduled 24h Reminder Job
      this.db
        .prepare(
          `INSERT INTO notification_jobs (id, booking_id, booking_revision, kind, scheduled_at, state, created_at, updated_at)
           VALUES (?, ?, 1, 'reminder', ?, 'pending', ?, ?)`
        )
        .bind(reminderJobId, booking.id, reminderTime, now, now),
      // Idempotency Record
      this.db
        .prepare(
          `INSERT INTO booking_operations (operation_key, customer_id, action, argument_fingerprint, booking_id, status, result_json, created_at, updated_at)
           VALUES (?, ?, 'book', ?, ?, 'succeeded', ?, ?, ?)`
        )
        .bind(context.operationKey, context.customerId, JSON.stringify(input), booking.id, JSON.stringify(result), now, now),
    ]);

    return result;
  }

  async rescheduleTrial(context: BookingMutationContext, input: RescheduleTrialInput): Promise<BookingResult> {
    const now = context.requestedAt || new Date().toISOString();

    const existing = await this.getBooking(context, input.bookingId);
    if (!existing) {
      return { status: 'failed', code: 'not_found', message: 'Booking not found.', retryable: false };
    }

    if (existing.revision !== input.expectedRevision) {
      return { status: 'failed', code: 'revision_conflict', message: 'Booking was modified elsewhere.', retryable: false };
    }

    const validation = validateBookingSlot(input.startsAt, now);
    if (!validation.valid || !validation.startsAtUtc || !validation.endsAtUtc) {
      return { status: 'failed', code: 'invalid_schedule', message: validation.reason || 'Invalid time slot.', retryable: false };
    }

    // Update Calendar event
    if (this.calendarClient && existing.calendar?.eventId) {
      try {
        await this.calendarClient.updateTrialEvent(existing.calendar.eventId, {
          startsAt: validation.startsAtUtc,
          endsAt: validation.endsAtUtc,
        });
      } catch (err) {
        console.error('[BookingService] Failed to update calendar event:', err);
        return { status: 'failed', code: 'dependency_unavailable', message: 'Could not update calendar event.', retryable: true };
      }
    }

    const newRevision = existing.revision + 1;
    const updatedBooking: TrialBooking = {
      ...existing,
      startsAt: validation.startsAtUtc,
      endsAt: validation.endsAtUtc,
      revision: newRevision,
      updatedAt: now,
    };

    const result: BookingResult = { status: 'succeeded', booking: updatedBooking };

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE bookings
           SET starts_at = ?, ends_at = ?, revision = ?, updated_at = ?
           WHERE id = ? AND customer_id = ?`
        )
        .bind(updatedBooking.startsAt, updatedBooking.endsAt, newRevision, now, updatedBooking.id, context.customerId),
      // Cancel previous pending reminder jobs
      this.db
        .prepare(`UPDATE notification_jobs SET state = 'cancelled', updated_at = ? WHERE booking_id = ? AND state = 'pending'`)
        .bind(now, updatedBooking.id),
      // Insert new reminder job
      this.db
        .prepare(
          `INSERT INTO notification_jobs (id, booking_id, booking_revision, kind, scheduled_at, state, created_at, updated_at)
           VALUES (?, ?, ?, 'reminder', ?, 'pending', ?, ?)`
        )
        .bind(`job_rem_${crypto.randomUUID()}`, updatedBooking.id, newRevision, new Date(new Date(validation.startsAtUtc).getTime() - 24 * 60 * 60 * 1000).toISOString(), now, now),
      // Record operation
      this.db
        .prepare(
          `INSERT INTO booking_operations (operation_key, customer_id, action, argument_fingerprint, booking_id, status, result_json, created_at, updated_at)
           VALUES (?, ?, 'reschedule', ?, ?, 'succeeded', ?, ?, ?)`
        )
        .bind(context.operationKey, context.customerId, JSON.stringify(input), updatedBooking.id, JSON.stringify(result), now, now),
    ]);

    return result;
  }

  async cancelTrial(context: BookingMutationContext, input: CancelTrialInput): Promise<BookingResult> {
    const now = context.requestedAt || new Date().toISOString();

    const existing = await this.getBooking(context, input.bookingId);
    if (!existing) {
      return { status: 'failed', code: 'not_found', message: 'Booking not found.', retryable: false };
    }

    if (this.calendarClient && existing.calendar?.eventId) {
      try {
        await this.calendarClient.deleteTrialEvent(existing.calendar.eventId);
      } catch (err) {
        console.error('[BookingService] Failed to delete calendar event:', err);
      }
    }

    const cancelledBooking: TrialBooking = {
      ...existing,
      status: 'cancelled',
      revision: existing.revision + 1,
      updatedAt: now,
    };

    const result: BookingResult = { status: 'succeeded', booking: cancelledBooking };

    await this.db.batch([
      this.db
        .prepare(`UPDATE bookings SET status = 'cancelled', revision = revision + 1, updated_at = ? WHERE id = ? AND customer_id = ?`)
        .bind(now, existing.id, context.customerId),
      this.db
        .prepare(`UPDATE notification_jobs SET state = 'cancelled', updated_at = ? WHERE booking_id = ? AND state = 'pending'`)
        .bind(now, existing.id),
      this.db
        .prepare(
          `INSERT INTO booking_operations (operation_key, customer_id, action, argument_fingerprint, booking_id, status, result_json, created_at, updated_at)
           VALUES (?, ?, 'cancel', ?, ?, 'succeeded', ?, ?, ?)`
        )
        .bind(context.operationKey, context.customerId, JSON.stringify(input), existing.id, JSON.stringify(result), now, now),
    ]);

    return result;
  }
}
