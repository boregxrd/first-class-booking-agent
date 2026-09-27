import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BookingMutationContext } from '../../model.js';
import { D1BookingService } from './service.js';
import { validateBookingSlot } from '../gym/schedule.js';
import type { GoogleCalendarClient } from '../calendar/client.js';

test('validateBookingSlot accepts valid Monday morning slot within Dallas hours', () => {
  // 2026-09-28 is a Monday. 08:00 AM Dallas (CDT = UTC-5) is 13:00 UTC
  const slotInstant = '2026-09-28T13:00:00.000Z';
  const nowInstant = '2026-09-27T12:00:00.000Z'; // 1 day before

  const res = validateBookingSlot(slotInstant, nowInstant);
  assert.equal(res.valid, true);
  assert.equal(res.localDate, '2026-09-28');
  assert.equal(res.localTime, '08:00');
});

test('validateBookingSlot rejects slots starting on Sunday (closed)', () => {
  // 2026-09-27 is a Sunday.
  const slotInstant = '2026-09-27T13:00:00.000Z';
  const nowInstant = '2026-09-26T12:00:00.000Z';

  const res = validateBookingSlot(slotInstant, nowInstant);
  assert.equal(res.valid, false);
  assert.match(res.reason || '', /No class is scheduled/);
});

test('validateBookingSlot rejects slots with less than 60-min lead time', () => {
  const now = new Date('2026-09-28T12:30:00.000Z');
  const slot = new Date('2026-09-28T13:00:00.000Z'); // only 30 min away

  const res = validateBookingSlot(slot.toISOString(), now.toISOString());
  assert.equal(res.valid, false);
  assert.match(res.reason || '', /less than 1 hour/);
});

test('D1BookingService bookTrial enforces idempotency and handles duplicate booking attempts', async () => {
  const operations = new Map<string, string>();
  const bookings = new Map<string, any>();
  const customers = new Map<string, any>([['cust_123', { name: 'Ana García', whatsapp_phone: '+12145550101', language: 'es' }]]);

  // Mock D1 Database
  const mockDb: any = {
    prepare(query: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              if (query.includes('FROM booking_operations')) {
                const key = `${args[0]}_${args[1]}`;
                if (operations.has(key)) return { result_json: operations.get(key), action: 'book', argument_fingerprint: JSON.stringify({ startsAt: '2026-09-28T13:00:00.000Z' }) };
                return null;
              }
              if (query.includes('FROM bookings')) {
                const existing = Array.from(bookings.values()).find((b) => b.customer_id === args[0] && b.status === 'confirmed');
                return existing || null;
              }
              if (query.includes('FROM customers')) {
                return customers.get(args[0]) || null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements: any[]) {
      for (const st of statements) {
        // execute mock inserts
      }
      return [];
    },
  };

  const calendar = {
    configuredCalendarId: 'test-calendar',
    createTrialEvent: async () => ({ id: 'event', etag: 'etag' }),
  } as unknown as GoogleCalendarClient;
  const bookingService = new D1BookingService(mockDb, calendar);

  const context: BookingMutationContext = {
    customerId: 'cust_123',
    conversationId: 'conv_1',
    sourceMessageId: 'msg_1',
    confirmationMessageId: 'msg_2',
    operationKey: 'op_unique_1',
    requestedAt: '2026-09-27T12:00:00.000Z',
  };

  // 1. First booking -> succeeds
  const res1 = await bookingService.bookTrial(context, {
    startsAt: '2026-09-28T13:00:00.000Z', // Monday 8:00 AM Dallas
  });

  assert.equal(res1.status, 'succeeded');
  if (res1.status === 'succeeded') {
    assert.equal(res1.booking.customerId, 'cust_123');
    assert.equal(res1.booking.status, 'confirmed');

    // Simulate saving in DB maps for idempotency test
    operations.set(`cust_123_op_unique_1`, JSON.stringify(res1));
    bookings.set(res1.booking.id, { ...res1.booking, customer_id: 'cust_123' });
  }

  // 2. Replay same operation key -> returns cached result
  const res2 = await bookingService.bookTrial(context, {
    startsAt: '2026-09-28T13:00:00.000Z',
  });

  assert.equal(res2.status, 'succeeded');
  if (res2.status === 'succeeded') {
    assert.equal(res2.booking.id, (res1 as any).booking.id);
  }

  // 3. New operation key for same customer -> rejected with already_booked
  const context2: BookingMutationContext = {
    ...context,
    operationKey: 'op_new_2',
  };

  const res3 = await bookingService.bookTrial(context2, {
    startsAt: '2026-09-29T13:00:00.000Z',
  });

  assert.equal(res3.status, 'failed');
  if (res3.status === 'failed') {
    assert.equal(res3.code, 'already_booked');
  }
});
