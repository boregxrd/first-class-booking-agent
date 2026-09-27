import assert from 'node:assert/strict';
import test from 'node:test';
import { localD1, TEST_NOW, TEST_SLOT, seedCustomer, FakeRosterCalendar, bookingContext } from './fixtures.js';
import { D1ConversationControls } from '../conversations/controls.js';
import { D1ConversationStore } from '../conversations/d1-store.js';
import { createConversationProcessor } from '../conversations/processor.js';
import { D1BookingService } from '../../bookings/service.js';
import type { InboundMessage } from '../../../model.js';
import type { ModelClient, ModelReply } from '../agent/client.js';

test('channel linking requires both code possession and the registered WhatsApp sender; opt-out and language persist', async () => {
  const { db, dispose } = await localD1();
  try {
    const store = new D1ConversationStore(db);
    const controls = new D1ConversationControls(db);
    const ig = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: 'tester' };
    let target = '';
    let code = '';
    await store.withConversation(ig, async (session) => {
      target = session.state.customer.id;
      session.state.customer.whatsappPhone = '+12145550101';
      session.state.customer.name = 'Ana';
      await session.save(session.state);
      const result = await controls.handle({ identity: ig, providerMessageId: 'link', text: 'vincular WhatsApp', sentAt: TEST_NOW, receivedAt: TEST_NOW }, session.state, TEST_NOW);
      code = result!.match(/vincular ([a-f0-9]{12})/)![1]!;
    });
    const wrong = { channel: 'whatsapp' as const, businessAccountId: 'wa', senderId: '12145550999' };
    await store.withConversation(wrong, async (session) => {
      await controls.handle({ identity: wrong, providerMessageId: 'bad', text: `link ${code}`, sentAt: TEST_NOW, receivedAt: TEST_NOW }, session.state, TEST_NOW);
      assert.notEqual(session.state.customer.id, target);
    });
    const wa = { ...wrong, senderId: '12145550101' };
    await store.withConversation(wa, async (session) => {
      const incoming = { identity: wa, providerMessageId: 'good', text: `link ${code}`, sentAt: TEST_NOW, receivedAt: TEST_NOW };
      const reply = await controls.handle(incoming, session.state, TEST_NOW);
      assert.equal(session.state.customer.id, target);
      await session.complete(incoming, session.state, { reply: reply!, bookingStatus: 'none', usage: { inputTokens: 0, outputTokens: 0 } });
    });
    await store.withConversation(wa, async (session) => {
      assert.equal(session.state.customer.id, target);
      await controls.handle({ identity: wa, providerMessageId: 'language', text: 'English', sentAt: TEST_NOW, receivedAt: TEST_NOW }, session.state, TEST_NOW);
      assert.equal(session.state.customer.language, 'en');
      session.state.customer.whatsappConsent = { phone: '+12145550101', purpose: 'trial_confirmation_and_reminders', grantedAt: TEST_NOW,
        sourceIdentity: wa, sourceMessageId: 'consent', revokedAt: null };
      await session.save(session.state);
      await controls.handle({ identity: wa, providerMessageId: 'stop', text: 'STOP', sentAt: TEST_NOW, receivedAt: TEST_NOW }, session.state, TEST_NOW);
      await session.save(session.state);
    });
    assert.ok((await db.prepare('SELECT revoked_at FROM consents WHERE customer_id = ?').bind(target).first<{ revoked_at: string }>())?.revoked_at);
    await store.withConversation(wa, async (session) => assert.equal(session.state.customer.language, 'en'));
  } finally { await dispose(); }
});

test('agent reschedule/cancel tools require confirmation and never expose another customer booking', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar();
    const bookings = new D1BookingService(db, calendar, () => TEST_NOW);
    const store = new D1ConversationStore(db);
    const identity = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: 'ana' };
    let customer = '';
    await store.withConversation(identity, async (session) => {
      customer = session.state.customer.id;
      session.state.customer.name = 'Ana'; session.state.customer.instagramHandle = '@ana';
      await session.save(session.state);
    });
    const initial = await bookings.bookTrial(bookingContext(customer), { startsAt: TEST_SLOT });
    if (initial.status !== 'succeeded') throw new Error('expected booking');
    const responses: ModelReply[] = [];
    const tool = (name: string, args: object): ModelReply => ({ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'tool', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, usage: { inputTokens: 1, outputTokens: 1 } });
    const model: ModelClient = { complete: async () => { const result = responses.shift(); assert.ok(result); return result; } };
    const process = createConversationProcessor({ model, bookings, store, now: () => TEST_NOW });
    const msg = (id: string, text: string): InboundMessage => ({ identity, providerMessageId: id, text, receivedAt: TEST_NOW, sentAt: TEST_NOW });
    const newTime = '2026-09-28T14:00:00.000Z';
    responses.push(tool('proposeReschedule', { bookingId: initial.booking.id, startsAt: newTime }));
    assert.equal((await process(msg('change', 'Move it to nine'))).bookingStatus, 'awaiting_confirmation');
    assert.equal((await bookings.getBooking(bookingContext(customer), initial.booking.id))?.startsAt, TEST_SLOT);
    assert.equal((await process(msg('change-confirm', 'sí confirmo'))).bookingStatus, 'confirmed');
    assert.equal((await bookings.getBooking(bookingContext(customer), initial.booking.id))?.startsAt, newTime);
    responses.push(tool('proposeCancellation', { bookingId: initial.booking.id }));
    assert.equal((await process(msg('cancel', 'Cancel it'))).bookingStatus, 'awaiting_confirmation');
    assert.equal((await process(msg('cancel-confirm', 'yes confirm'))).bookingStatus, 'cancelled');
    await seedCustomer(db, 'other', null, '@other');
    const other = await bookings.bookTrial(bookingContext('other'), { startsAt: TEST_SLOT });
    if (other.status !== 'succeeded') throw new Error('expected booking');
    responses.push(tool('proposeCancellation', { bookingId: other.booking.id }), { message: { role: 'assistant', content: 'No booking found.' }, usage: { inputTokens: 1, outputTokens: 1 } });
    assert.equal((await process(msg('foreign', 'Cancel another booking'))).bookingStatus, 'none');
    assert.equal((await bookings.getBooking(bookingContext('other'), other.booking.id))?.status, 'confirmed');
  } finally { await dispose(); }
});
