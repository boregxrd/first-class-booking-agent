import assert from 'node:assert/strict';
import test from 'node:test';
import { localD1, FakeRosterCalendar, seedCustomer, bookingContext, TEST_NOW, TEST_SLOT } from './fixtures.js';
import { D1BookingService } from '../../bookings/service.js';
import { D1NotificationScheduler, D1NotificationStatusHandler } from '../../notifications/scheduler.js';
import { inspectCalendarSlot } from '../../calendar/reconcile.js';
import { deriveSlotRosterEventId } from '../../calendar/slot-roster.js';
import { recoverDeliveries } from '../runtime/delivery.js';

const config = { businessAccountId: 'wa', confirmationTemplate: 'confirm', reminderTemplate: 'remind' };

test('manual class move pauses ALL slot notifications and recovery clears the alert', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar(); const bookings = new D1BookingService(db, calendar, () => TEST_NOW);
    for (const id of ['ana', 'sofia']) { await seedCustomer(db, id); await bookings.bookTrial(bookingContext(id), { startsAt: TEST_SLOT }); }
    const eventId = await deriveSlotRosterEventId(TEST_SLOT);
    const original = structuredClone(calendar.events.get(eventId)!);
    calendar.events.set(eventId, { ...original, start: { dateTime: '2026-09-28T15:00:00Z' } });
    let sends = 0;
    const scheduler = new D1NotificationScheduler(db, { sendTemplate: async () => { sends++; return { status: 'accepted', providerMessageId: `p${sends}` }; } }, calendar, config);
    assert.equal(await scheduler.processDueNotifications(TEST_NOW), 0);
    assert.equal(sends, 0);
    assert.equal((await db.prepare('SELECT state FROM calendar_slot_health').first<{ state: string }>())?.state, 'blocked');
    calendar.events.set(eventId, original);
    assert.ok(await inspectCalendarSlot(db, calendar, TEST_SLOT, eventId, TEST_NOW));
    assert.equal((await db.prepare("SELECT state FROM operational_alerts WHERE kind = 'calendar_slot_blocked'").first<{ state: string }>())?.state, 'resolved');
    assert.equal(await scheduler.processDueNotifications('2026-09-27T12:10:00.000Z'), 2);
  } finally { await dispose(); }
});

test('cancellation during an in-flight notification is deferred; subsequent retry succeeds', async () => {
  const { db, dispose } = await localD1();
  try {
    await seedCustomer(db, 'ana'); const calendar = new FakeRosterCalendar();
    const bookings = new D1BookingService(db, calendar, () => TEST_NOW);
    const booking = await bookings.bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT });
    if (booking.status !== 'succeeded') throw new Error('expected booking');
    let release!: () => void; let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new D1NotificationScheduler(db, { sendTemplate: async () => { started(); await wait; return { status: 'accepted', providerMessageId: 'provider' }; } }, calendar, config);
    const sending = scheduler.processDueNotifications(TEST_NOW); await waiting;
    const input = { bookingId: booking.booking.id, expectedRevision: 1 };
    const blocked = await bookings.cancelTrial(bookingContext('ana', 'cancel'), input);
    assert.equal(blocked.status === 'failed' && blocked.retryable, true);
    release(); await sending;
    assert.equal((await bookings.cancelTrial(bookingContext('ana', 'cancel'), input)).status, 'succeeded');
  } finally { await dispose(); }
});

test('early, duplicate and out-of-order receipts converge without resending; expired sends become unknown', async () => {
  const { db, dispose } = await localD1();
  try {
    await seedCustomer(db, 'ana'); const calendar = new FakeRosterCalendar();
    await new D1BookingService(db, calendar, () => TEST_NOW).bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT });
    const receipts = new D1NotificationStatusHandler(db);
    const scheduler = new D1NotificationScheduler(db, { sendTemplate: async (request) => {
      const receipt = { businessAccountId: 'wa', providerMessageId: 'provider', status: 'read' as const, occurredAt: TEST_NOW, correlationId: request.notificationJobId };
      await receipts.handleDeliveryUpdate(receipt);
      await receipts.handleDeliveryUpdate(receipt);
      await receipts.handleDeliveryUpdate({ ...receipt, status: 'failed', occurredAt: '2026-09-27T12:00:01.000Z' });
      return { status: 'accepted', providerMessageId: 'provider' };
    } }, calendar, config);
    await scheduler.processDueNotifications(TEST_NOW);
    assert.equal((await db.prepare("SELECT delivery_status FROM notification_jobs WHERE kind = 'confirmation'").first<{ delivery_status: string }>())?.delivery_status, 'read');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM notification_delivery_events').first<{ n: number }>())?.n, 2);
    await db.prepare("UPDATE notification_jobs SET state = 'sending', lease_expires_at = '1970-01-01' WHERE kind = 'reminder'").run();
    await recoverDeliveries(db, 'notification_jobs', TEST_NOW);
    assert.equal((await db.prepare("SELECT state FROM notification_jobs WHERE kind = 'reminder'").first<{ state: string }>())?.state, 'unknown');
    await receipts.handleDeliveryUpdate({ businessAccountId: 'wa', providerMessageId: 'early-without-correlation', status: 'delivered', occurredAt: TEST_NOW });
    await db.prepare("UPDATE notification_jobs SET provider_message_id = 'early-without-correlation', business_account_id = 'wa' WHERE kind = 'reminder'").run();
    await receipts.reconcileStoredReceipts();
    assert.equal((await db.prepare("SELECT delivery_status FROM notification_jobs WHERE kind = 'reminder'").first<{ delivery_status: string }>())?.delivery_status, 'delivered');
  } finally { await dispose(); }
});
