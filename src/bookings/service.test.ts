import assert from 'node:assert/strict';
import test from 'node:test';
import { D1BookingService } from './service.js';
import { validateBookingSlot } from '../gym/schedule.js';
import { deriveSlotRosterEventId } from '../calendar/slot-roster.js';
import { D1NotificationScheduler } from '../notifications/scheduler.js';
import { localD1, FakeRosterCalendar, seedCustomer, bookingContext, TEST_NOW, TEST_SLOT } from '../llm-integration/tests/fixtures.js';

test('schedule uses Dallas hours, rejects Sunday, short lead times and sub-minute starts', () => {
  assert.equal(validateBookingSlot(TEST_SLOT, TEST_NOW).localTime, '08:00');
  assert.equal(validateBookingSlot('2026-09-27T13:00:00Z', '2026-09-26T12:00:00Z').valid, false);
  assert.equal(validateBookingSlot(TEST_SLOT, '2026-09-28T12:30:00Z').valid, false);
  assert.equal(validateBookingSlot('2026-09-28T13:00:01Z', TEST_NOW).valid, false);
});

test('shared roster: two prospects, replay, move only one, cancel only one and reuse empty slot', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar();
    const service = new D1BookingService(db, calendar, () => TEST_NOW);
    await seedCustomer(db, 'ana');
    await seedCustomer(db, 'sofia', null, '@sofia.fit');
    const [ana, sofia] = await Promise.all([
      service.bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT }),
      service.bookTrial(bookingContext('sofia'), { startsAt: TEST_SLOT }),
    ]);
    assert.equal(ana.status, 'succeeded'); assert.equal(sofia.status, 'succeeded');
    if (ana.status !== 'succeeded' || sofia.status !== 'succeeded') throw new Error('expected bookings');
    assert.equal(calendar.events.size, 1);
    const slotId = await deriveSlotRosterEventId(TEST_SLOT);
    const description = calendar.events.get(slotId)!.description!;
    assert.match(description, /Name ana/); assert.match(description, /Name sofia/);
    assert.match(description, /Phone: \+12145550101/); assert.match(description, /Instagram: @sofia.fit/);
    assert.match(description, /Language: es/); assert.match(description, /Booking ID:/);
    assert.equal(ana.booking.calendar?.eventId, sofia.booking.calendar?.eventId);
    assert.equal(ana.booking.endsAt, '2026-09-28T14:00:00.000Z');
    const writes = calendar.writes;
    assert.deepEqual(await service.bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT }), ana);
    assert.equal(calendar.writes, writes);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM notification_jobs WHERE booking_id = ?').bind(sofia.booking.id).first<{ n: number }>())?.n, 0);
    assert.deepEqual((await db.prepare('SELECT kind, scheduled_at FROM notification_jobs WHERE booking_id = ? ORDER BY kind')
      .bind(ana.booking.id).all<{ kind: string; scheduled_at: string }>()).results, [
      { kind: 'confirmation', scheduled_at: TEST_NOW },
      { kind: 'reminder', scheduled_at: '2026-09-27T13:00:00.000Z' },
      { kind: 'reminder_1h', scheduled_at: '2026-09-28T12:00:00.000Z' },
    ]);
    assert.equal(await service.getBooking(bookingContext('sofia'), ana.booking.id), null);
    const conflict = await service.bookTrial(bookingContext('ana'), { startsAt: '2026-09-29T13:00:00.000Z' });
    assert.equal(conflict.status === 'failed' && conflict.code, 'idempotency_conflict');

    const nextSlot = '2026-09-28T14:00:00.000Z';
    const moveInput = { bookingId: ana.booking.id, expectedRevision: 1, startsAt: nextSlot };
    const moved = await service.rescheduleTrial(bookingContext('ana', 'move'), moveInput);
    assert.equal(moved.status, 'succeeded');
    assert.deepEqual(await service.rescheduleTrial(bookingContext('ana', 'move'), moveInput), moved);
    assert.equal(calendar.events.size, 2);
    assert.doesNotMatch(calendar.events.get(slotId)!.description!, /Name ana/);
    assert.match(calendar.events.get(slotId)!.description!, /Name sofia/);
    assert.equal(calendar.events.get(slotId)!.start.dateTime, TEST_SLOT, 'never move the shared event');
    const stale = await service.cancelTrial(bookingContext('ana', 'stale'), { bookingId: ana.booking.id, expectedRevision: 1 });
    assert.equal(stale.status === 'failed' && stale.code, 'revision_conflict');
    const cancelInput = { bookingId: sofia.booking.id, expectedRevision: 1 };
    const cancelled = await service.cancelTrial(bookingContext('sofia', 'cancel'), cancelInput);
    assert.equal(cancelled.status, 'succeeded');
    assert.deepEqual(await service.cancelTrial(bookingContext('sofia', 'cancel'), cancelInput), cancelled);
    assert.match(calendar.events.get(slotId)!.description!, /Prospects \(0\)/);
    assert.match(calendar.events.get(await deriveSlotRosterEventId(nextSlot))!.description!, /Name ana/);
    await seedCustomer(db, 'third');
    await service.bookTrial(bookingContext('third'), { startsAt: TEST_SLOT });
    assert.equal(calendar.events.size, 2);
    assert.match(calendar.events.get(slotId)!.description!, /Name third/);
    assert.doesNotMatch(calendar.events.get(slotId)!.description!, /Name sofia/);
  } finally { await dispose(); }
});

test('timeout-after-create and DB-finalization failure recover without duplicate events/people', async () => {
  const { db, dispose } = await localD1();
  try {
    await seedCustomer(db, 'ana');
    const calendar = new FakeRosterCalendar();
    const service = new D1BookingService(db, calendar, () => TEST_NOW);
    calendar.timeoutAfterWrite = true;
    const first = await service.bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT });
    assert.equal(first.status, 'pending');
    assert.equal(calendar.events.size, 1);
    // Exercise a real SQL rollback after Calendar successfully updates the roster.
    await db.prepare("CREATE TRIGGER fail_finalize BEFORE UPDATE ON booking_operations WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'simulated DB failure'); END").run();
    assert.equal((await service.bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT })).status, 'pending');
    await db.prepare('DROP TRIGGER fail_finalize').run();
    await service.reconcilePendingOperations();
    const recovered = await service.bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT });
    assert.equal(recovered.status, 'succeeded');
    if (first.status === 'pending' && recovered.status === 'succeeded') assert.equal(first.bookingId, recovered.booking.id);
    assert.equal(calendar.events.size, 1);
    assert.equal([...calendar.events.values()][0]!.description!.match(/Name ana/g)?.length, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM bookings').first<{ n: number }>())?.n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM notification_jobs').first<{ n: number }>())?.n, 3);
  } finally { await dispose(); }
});

test('missed reminders are omitted while a reminder exactly one hour away is scheduled', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar();
    await seedCustomer(db, 'within-24h');
    const service = new D1BookingService(db, calendar, () => TEST_NOW);
    const soon = await service.bookTrial(bookingContext('within-24h'), { startsAt: '2026-09-28T11:00:00.000Z' });
    if (soon.status !== 'succeeded') throw new Error('expected booking');
    assert.deepEqual((await db.prepare('SELECT kind FROM notification_jobs WHERE booking_id = ? ORDER BY kind')
      .bind(soon.booking.id).all<{ kind: string }>()).results.map(({ kind }) => kind), ['confirmation', 'reminder_1h']);

    const exactlyOneHourBefore = '2026-09-28T12:00:00.000Z';
    await seedCustomer(db, 'one-hour', '+12145550102');
    const justInTime = new D1BookingService(db, calendar, () => exactlyOneHourBefore);
    const booking = await justInTime.bookTrial({
      ...bookingContext('one-hour'), requestedAt: exactlyOneHourBefore,
    }, { startsAt: '2026-09-28T13:00:00.000Z' });
    if (booking.status !== 'succeeded') throw new Error('expected booking');
    assert.deepEqual((await db.prepare('SELECT kind, scheduled_at FROM notification_jobs WHERE booking_id = ? ORDER BY kind')
      .bind(booking.booking.id).all<{ kind: string; scheduled_at: string }>()).results, [
      { kind: 'confirmation', scheduled_at: exactlyOneHourBefore },
      { kind: 'reminder_1h', scheduled_at: exactlyOneHourBefore },
    ]);
  } finally { await dispose(); }
});

test('partial two-slot reschedule and cancellation outages are pending and reconcilable', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar();
    const service = new D1BookingService(db, calendar, () => TEST_NOW);
    await seedCustomer(db, 'ana'); await seedCustomer(db, 'other');
    const booked = await service.bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT });
    await service.bookTrial(bookingContext('other'), { startsAt: TEST_SLOT });
    if (booked.status !== 'succeeded') throw new Error('booking failed');
    const next = '2026-09-28T14:00:00.000Z';
    calendar.failSlot = next;
    const moved = await service.rescheduleTrial(bookingContext('ana', 'move'), { bookingId: booked.booking.id, startsAt: next, expectedRevision: 1 });
    assert.equal(moved.status, 'pending');
    assert.match(calendar.events.get(await deriveSlotRosterEventId(TEST_SLOT))!.description!, /Name other/);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM notification_jobs WHERE booking_id = ? AND state = 'pending'").bind(booked.booking.id).first<{ n: number }>())?.n, 0);
    calendar.failSlot = null;
    await service.reconcilePendingOperations();
    calendar.failSlot = next;
    assert.equal((await service.cancelTrial(bookingContext('ana', 'cancel'), { bookingId: booked.booking.id, expectedRevision: 2 })).status, 'pending');
    calendar.failSlot = null;
    await service.reconcilePendingOperations();
    assert.match(calendar.events.get(await deriveSlotRosterEventId(next))!.description!, /Prospects \(0\)/);
    assert.match(calendar.events.get(await deriveSlotRosterEventId(TEST_SLOT))!.description!, /Name other/);
  } finally { await dispose(); }
});

test('concurrent creates for one customer allow only one active booking; missing contact/calendar fail', async () => {
  const { db, dispose } = await localD1();
  try {
    const service = new D1BookingService(db, new FakeRosterCalendar(), () => TEST_NOW);
    await seedCustomer(db, 'ana');
    const results = await Promise.all(['one', 'two'].map((key) => service.bookTrial(bookingContext('ana', key), { startsAt: TEST_SLOT })));
    assert.equal(results.filter((result) => result.status === 'succeeded').length, 1);
    assert.equal(results.filter((result) => result.status === 'failed' && result.code === 'already_booked').length, 1);
    await seedCustomer(db, 'missing', null, null);
    const missing = await service.bookTrial(bookingContext('missing'), { startsAt: TEST_SLOT });
    assert.equal(missing.status === 'failed' && missing.code, 'missing_customer_details');
    assert.equal((await new D1BookingService(db, null).bookTrial(bookingContext('missing'), { startsAt: TEST_SLOT })).status, 'failed');
  } finally { await dispose(); }
});

test('recent trial lookup matches customer, phone or Instagram handle and ignores ineligible history', async () => {
  const { db, dispose } = await localD1();
  try {
    const service = new D1BookingService(db, new FakeRosterCalendar(), () => TEST_NOW);
    const addHistory = async (id: string, customerId: string, startsAt: string, status: string) => {
      await db.prepare(`INSERT INTO bookings
        (id, customer_id, starts_at, ends_at, time_zone, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'America/Chicago', ?, 1, ?, ?)`)
        .bind(id, customerId, startsAt, '2026-09-28T14:00:00.000Z', status, TEST_NOW, TEST_NOW).run();
    };

    await seedCustomer(db, 'same-customer', null, null);
    await addHistory('history-customer', 'same-customer', '2026-09-20T13:00:00.000Z', 'elapsed');
    assert.equal(await service.hasRecentTrial(bookingContext('same-customer'), { phone: null, instagramHandle: null }), true);

    await seedCustomer(db, 'phone-owner');
    await seedCustomer(db, 'phone-alias');
    await addHistory('history-phone', 'phone-owner', '2026-09-20T13:00:00.000Z', 'confirmed');
    assert.equal(await service.hasRecentTrial(bookingContext('phone-alias'), { phone: '+12145550101', instagramHandle: null }), true);

    await seedCustomer(db, 'handle-owner', '+12145550201', '@Ana.Fit');
    await seedCustomer(db, 'handle-alias', '+12145550202', '@other');
    await addHistory('history-handle', 'handle-owner', '2026-09-20T13:00:00.000Z', 'elapsed');
    assert.equal(await service.hasRecentTrial(bookingContext('handle-alias'), { phone: null, instagramHandle: 'ana.fit' }), true);

    await seedCustomer(db, 'cancelled-owner', '+12145550301', '@cancelled');
    await addHistory('history-cancelled', 'cancelled-owner', '2026-09-20T13:00:00.000Z', 'cancelled');
    assert.equal(await service.hasRecentTrial(bookingContext('cancelled-owner'), { phone: '+12145550301', instagramHandle: null }), false);

    await seedCustomer(db, 'old-owner', '+12145550401', '@old');
    await addHistory('history-old', 'old-owner', '2026-08-27T11:59:59.000Z', 'elapsed');
    assert.equal(await service.hasRecentTrial(bookingContext('old-owner'), { phone: '+12145550401', instagramHandle: null }), false);

    await seedCustomer(db, 'future-owner', '+12145550501', '@future');
    await addHistory('history-future', 'future-owner', '2026-09-28T13:00:00.000Z', 'confirmed');
    assert.equal(await service.hasRecentTrial(bookingContext('future-owner'), { phone: '+12145550501', instagramHandle: null }), false);
  } finally { await dispose(); }
});

test('booking a second trial within 30 days is blocked by customer contact', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar();
    const service = new D1BookingService(db, calendar, () => TEST_NOW);
    await seedCustomer(db, 'previous');
    await seedCustomer(db, 'new-identity');
    await db.prepare(`INSERT INTO bookings
      (id, customer_id, starts_at, ends_at, time_zone, status, revision, created_at, updated_at)
      VALUES ('previous-trial', 'previous', '2026-09-20T13:00:00.000Z', '2026-09-20T14:00:00.000Z',
        'America/Chicago', 'elapsed', 1, ?, ?)`).bind(TEST_NOW, TEST_NOW).run();

    const result = await service.bookTrial(bookingContext('new-identity'), { startsAt: TEST_SLOT });
    assert.equal(result.status === 'failed' && result.code, 'trial_not_eligible');
    assert.equal((await db.prepare("SELECT count(*) AS n FROM bookings WHERE customer_id = 'new-identity'").first<{ n: number }>())?.n, 0);
    assert.equal(calendar.events.size, 0);
  } finally { await dispose(); }
});

test('a shared event still sends individual notifications and respects revoked consent', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar();
    const service = new D1BookingService(db, calendar, () => TEST_NOW);
    await seedCustomer(db, 'phone');
    await seedCustomer(db, 'instagram', null, '@instagram.only');
    await service.bookTrial(bookingContext('phone'), { startsAt: TEST_SLOT });
    await service.bookTrial(bookingContext('instagram'), { startsAt: TEST_SLOT });
    const recipients: string[] = [];
    const scheduler = new D1NotificationScheduler(db, { sendTemplate: async (request) => {
      recipients.push(request.to);
      return { status: 'accepted', providerMessageId: `message-${recipients.length}` };
    } }, calendar, { businessAccountId: 'wa-gym', confirmationTemplate: 'confirm', reminderTemplate: 'remind' });
    assert.equal(await scheduler.processDueNotifications(TEST_NOW), 1);
    assert.deepEqual(recipients, ['+12145550101']);
    await db.prepare('UPDATE consents SET revoked_at = ? WHERE customer_id = ?').bind(TEST_NOW, 'phone').run();
    assert.equal(await scheduler.processDueNotifications('2026-09-27T14:00:00.000Z'), 0);
    assert.equal(recipients.length, 1);
    assert.equal(calendar.events.size, 1);
  } finally { await dispose(); }
});
