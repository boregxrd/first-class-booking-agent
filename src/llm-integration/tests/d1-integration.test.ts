import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { D1ConversationStore } from '../conversations/d1-store.js';
import { D1BookingService } from '../../bookings/service.js';
import type { GoogleCalendarClient } from '../../calendar/client.js';
import { createServices } from '../../runtime/factory.js';

test('real local D1: migrations, checkpoints, recent history, turn replay and booking SQL', async () => {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test"); } }', d1Databases: ['DB'] });
  try {
    const db = await runtime.getD1Database('DB') as unknown as D1Database;
    for (const name of ['0001_initial_schema.sql', '0002_conversation_checkpoints.sql']) {
      const sql = await readFile(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
      // Execute actual migration SQL, including real constraints, in local D1.
      for (const statement of sql.replace(/--[^\n]*/g, '').split(';').filter((part) => part.trim())) {
        await db.prepare(statement).run();
      }
    }
    const store = new D1ConversationStore(db);
    const identity = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: 'tester' };
    const now = '2026-09-27T12:00:00.000Z';
    const startsAt = '2026-09-28T13:00:00.000Z';
    let customerId = '';
    let conversationId = '';
    await store.withConversation(identity, async (session) => {
      customerId = session.state.customer.id;
      conversationId = session.state.id;
      session.state.customer.name = 'Test Prospect';
      session.state.customer.whatsappPhone = '+12145550101';
      session.state.customer.whatsappConsent = {
        phone: '+12145550101', purpose: 'trial_confirmation_and_reminders', grantedAt: now,
        sourceIdentity: identity, sourceMessageId: 'confirm', revokedAt: null,
      };
      session.state.bookingOperation = { startsAt, context: {
        customerId, conversationId, sourceMessageId: 'confirm', confirmationMessageId: 'confirm', operationKey: 'stable-key', requestedAt: now,
      } };
      await session.save(session.state);
    });
    await store.withConversation(identity, async (session) => {
      assert.equal(session.state.bookingOperation?.context.operationKey, 'stable-key');
      assert.equal(session.state.customer.whatsappConsent?.sourceMessageId, 'confirm');
      for (let index = 0; index < 12; index++) {
        const message = { identity, providerMessageId: `message-${index}`, text: `user-${index}`, sentAt: now, receivedAt: now };
        await session.complete(message, session.state, { reply: `reply-${index}`, bookingStatus: 'none', usage: { inputTokens: 1, outputTokens: 1 } });
      }
    });
    await store.withConversation(identity, async (session) => {
      assert.equal(session.state.history.length, 20);
      assert.equal(session.state.history[0]?.content, 'user-2');
      assert.equal(session.state.history.at(-1)?.content, 'reply-11');
      assert.equal((await session.getProcessedTurn('message-11'))?.reply, 'reply-11');
    });
    const context = { customerId, conversationId, sourceMessageId: 'confirm', confirmationMessageId: 'confirm', operationKey: 'booking-key', requestedAt: now };
    let calendarCalls = 0;
    const calendar = {
      configuredCalendarId: 'dedicated-trials-calendar',
      async createTrialEvent() { calendarCalls++; return { id: 'event-1', etag: 'etag-1' }; },
      async deleteTrialEvent() { throw new Error('simulated Calendar outage'); },
    } as unknown as GoogleCalendarClient;
    const service = new D1BookingService(db, calendar);
    const result = await service.bookTrial(context, { startsAt });
    assert.equal(result.status, 'succeeded');
    if (result.status !== 'succeeded') throw new Error('expected success');
    assert.equal(result.booking.calendar?.calendarId, 'dedicated-trials-calendar');
    assert.equal(result.booking.endsAt, '2026-09-28T14:00:00.000Z');
    assert.equal((await service.getBooking(context, result.booking.id))?.id, result.booking.id);
    assert.equal(await service.getBooking({ ...context, customerId: 'someone-else' }, result.booking.id), null);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM notification_jobs').first<{ n: number }>())?.n, 2);
    assert.deepEqual(await service.bookTrial(context, { startsAt }), result);
    assert.equal(calendarCalls, 1);
    const conflicting = await service.bookTrial(context, { startsAt: '2026-09-29T13:00:00.000Z' });
    assert.equal(conflicting.status, 'failed');
    if (conflicting.status === 'failed') assert.equal(conflicting.code, 'idempotency_conflict');
    const duplicate = await service.bookTrial({ ...context, operationKey: 'other-key' }, { startsAt });
    assert.equal(duplicate.status, 'failed');
    if (duplicate.status === 'failed') assert.equal(duplicate.code, 'already_booked');
    const unconfigured = await new D1BookingService(db, null).bookTrial({ ...context, operationKey: 'no-calendar' }, { startsAt });
    assert.equal(unconfigured.status, 'failed');
    assert.equal(calendarCalls, 1);
    const services = createServices({ DB: db, META_APP_SECRET: 'test', META_VERIFY_TOKEN: 'test' });
    assert.ok(services.statusHandler, 'receipt processing must not require an OpenAI key');
    assert.throws(() => services.processor, /OPENAI_API_KEY/);
    const staleCancel = await service.cancelTrial({ ...context, operationKey: 'cancel-stale' }, { bookingId: result.booking.id, expectedRevision: 99 });
    assert.equal(staleCancel.status, 'failed');
    if (staleCancel.status === 'failed') assert.equal(staleCancel.code, 'revision_conflict');
    const failedCancel = await service.cancelTrial({ ...context, operationKey: 'cancel-outage' }, { bookingId: result.booking.id, expectedRevision: 1 });
    assert.equal(failedCancel.status, 'failed');
    assert.equal((await service.getBooking(context, result.booking.id))?.status, 'confirmed');
  } finally { await runtime.dispose(); }
});
