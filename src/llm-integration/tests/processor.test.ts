import assert from 'node:assert/strict';
import test from 'node:test';
import type { BookingService, InboundMessage } from '../../../model.js';
import type { ChatMessage, ModelClient, ModelReply } from '../agent/client.js';
import { isScheduledTime } from '../agent/tools.js';
import { createConversationProcessor } from '../conversations/processor.js';
import type { ConversationSession, ConversationState, ConversationStore, TurnResult } from '../conversations/store.js';

const now = '2026-09-27T18:00:00.000Z';
const startsAt = '2026-09-28T13:00:00.000Z'; // 8 AM Dallas, not 8 AM UTC.
const schedule = {
  timeZone: 'America/Chicago' as const, weekly: [{ weekday: 1 as const, startTimes: ['08:00'] }],
  dateOverrides: [], durationMinutes: 60, minimumLeadMinutes: 0, bookingHorizonDays: 30,
};
const identity = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: 'prospect' };
const input = (id: string, text: string): InboundMessage => ({ identity, providerMessageId: id, text, sentAt: now, receivedAt: now });
const reply = (content: string): ModelReply => ({ message: { role: 'assistant', content }, usage: { inputTokens: 10, outputTokens: 5 } });
const propose = (args: unknown = { name: 'Ana', phone: '+34600000000', startsAt }): ModelReply => ({
  message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'proposeTrial', arguments: JSON.stringify(args) } }] },
  usage: { inputTokens: 10, outputTokens: 5 },
});

/** Test-only store. Production must implement durable checkpoints, locking and an outbox. */
function fixture(responses: ModelReply[]) {
  let state: ConversationState = {
    id: 'conversation-1', history: [], proposal: null, bookingOperation: null,
    customer: { id: 'customer-1', name: null, whatsappPhone: null, language: 'es', whatsappConsent: null, createdAt: now, updatedAt: now },
  };
  const results = new Map<string, TurnResult>();
  const requests: ChatMessage[][] = [];
  const operations: string[] = [];
  let failBooking = false;
  let failComplete = false;
  const session: ConversationSession = {
    get state() { return state; },
    getProcessedTurn: async (id) => results.get(id) ?? null,
    save: async (value) => { state = structuredClone(value); },
    complete: async (message, value, result) => {
      if (failComplete) throw new Error('storage unavailable');
      state = structuredClone(value); results.set(message.providerMessageId, result);
    },
  };
  const store: ConversationStore = { withConversation: async (_identity, work) => work(session) };
  const model: ModelClient = { complete: async (messages) => {
    requests.push(structuredClone(messages));
    const next = responses.shift();
    assert.ok(next, 'unexpected model invocation');
    return next;
  } };
  const bookings: BookingService = {
    getClassSchedule: async () => schedule,
    getBooking: async () => null,
    bookTrial: async (context, args) => {
      assert.equal(state.customer.name, 'Ana', 'customer checkpoint must precede booking');
      if (state.customer.whatsappPhone) assert.equal(state.customer.whatsappConsent?.sourceMessageId, 'confirmation');
      operations.push(context.operationKey);
      if (failBooking) throw new Error('timeout after remote creation');
      return { status: 'succeeded', booking: {
        id: 'booking-1', customerId: context.customerId, startsAt: args.startsAt, endsAt: '2026-09-28T14:00:00.000Z',
        timeZone: 'America/Chicago', status: 'confirmed', revision: 1,
        calendar: { calendarId: 'calendar', eventId: 'event', etag: null }, createdAt: now, updatedAt: now,
      } };
    },
    rescheduleTrial: async () => { throw new Error('not used'); },
    cancelTrial: async () => { throw new Error('not used'); },
  };
  return {
    process: createConversationProcessor({ model, bookings, store, now: () => now }),
    requests, operations, session,
    setFailBooking(value: boolean) { failBooking = value; },
    setFailComplete(value: boolean) { failComplete = value; },
  };
}

test('FAQ conversation retains recent context and never books', async () => {
  const f = fixture([reply('La primera clase es gratis 💖.'), reply('Sí, es para principiantes.')]);
  await f.process(input('first', '¿Cuánto cuesta?'));
  await f.process(input('second', '¿Y para principiantes?'));
  assert.equal(f.operations.length, 0);
  assert.ok(f.requests[1]!.some((m) => m.content === '¿Cuánto cuesta?'));
  assert.match(f.requests[0]![0]!.content!, /classDurationMinutes": 60/);
});

test('proposal only stages; explicit confirmation books and duplicate webhook replays result', async () => {
  const f = fixture([propose()]);
  const proposal = await f.process(input('details', 'Soy Ana, quiero el lunes a las 8, mi número es +34600000000'));
  assert.equal(proposal.bookingStatus, 'awaiting_confirmation');
  assert.match(proposal.reply, /sí confirmo/);
  assert.equal(f.operations.length, 0);
  assert.equal(f.session.state.customer.whatsappConsent, null);
  const confirmed = await f.process(input('confirmation', 'Sí confirmo'));
  assert.equal(confirmed.bookingStatus, 'confirmed');
  assert.equal(f.session.state.customer.whatsappPhone, '+34600000000');
  assert.deepEqual(await f.process(input('confirmation', 'Sí confirmo')), confirmed);
  assert.equal(f.operations.length, 1);
});

test('yes without a pending proposal cannot authorize a booking', async () => {
  const f = fixture([reply('¿Qué día prefieres?')]);
  await f.process(input('confirmation', 'sí confirmo'));
  assert.equal(f.operations.length, 0);
});

test('Instagram-only contact books after confirmation without granting WhatsApp consent', async () => {
  const f = fixture([propose({ name: 'Ana', phone: null, instagramHandle: '@ana.fit', startsAt })]);
  const proposal = await f.process(input('details', 'Soy Ana, mi Instagram es @ana.fit, quiero el lunes a las 8'));
  assert.equal(proposal.bookingStatus, 'awaiting_confirmation');
  assert.match(proposal.reply, /@ana.fit/);
  assert.doesNotMatch(proposal.reply, /WhatsApp/);
  assert.equal((await f.process(input('confirmation', 'sí confirmo'))).bookingStatus, 'confirmed');
  assert.equal(f.session.state.customer.whatsappPhone, null);
  assert.equal(f.session.state.customer.instagramHandle, '@ana.fit');
  assert.equal(f.session.state.customer.whatsappConsent, null);
});

test('a question/correction invalidates the previous confirmation target', async () => {
  const f = fixture([propose(), reply('No tengo datos de ocupación.'), reply('Confirmemos de nuevo los detalles.')]);
  await f.process(input('details', 'Quiero reservar'));
  await f.process(input('question', '¿Cuál está más vacía?'));
  assert.equal(f.session.state.proposal, null);
  await f.process(input('confirmation', 'sí confirmo'));
  assert.equal(f.operations.length, 0);
});

test('invalid or injected tool arguments do not create a proposal or booking', async () => {
  const f = fixture([propose({ name: 'Ana', phone: '600000000', startsAt, customerId: 'someone-else' }), reply('¿Cuál es el código de país?')]);
  const result = await f.process(input('details', 'Quiero reservar'));
  assert.equal(result.bookingStatus, 'none');
  assert.equal(f.session.state.proposal, null);
  assert.equal(f.operations.length, 0);
  assert.ok(f.requests[1]!.some((m) => m.role === 'tool' && m.content.includes('invalid_arguments')));
});

test('booking timeout resumes the checkpoint with the same idempotency key', async () => {
  const f = fixture([propose()]);
  await f.process(input('details', 'Quiero reservar'));
  f.setFailBooking(true);
  await assert.rejects(f.process(input('confirmation', 'sí confirmo')), /timeout/);
  assert.ok(f.session.state.bookingOperation);
  f.setFailBooking(false);
  assert.equal((await f.process(input('confirmation', 'sí confirmo'))).bookingStatus, 'confirmed');
  assert.equal(f.operations.length, 2);
  assert.equal(f.operations[0], f.operations[1]);
});

test('storage failure during proposal is not swallowed as a model/tool error', async () => {
  const f = fixture([propose()]);
  f.setFailComplete(true);
  await assert.rejects(f.process(input('details', 'Quiero reservar')), /storage unavailable/);
  assert.equal(f.operations.length, 0);
});

test('schedule validation honors Dallas time, closures, past dates and DST offsets', () => {
  assert.ok(isScheduledTime(startsAt, schedule, now));
  assert.equal(isScheduledTime('2026-09-28T08:00:00Z', schedule, now), false);
  assert.equal(isScheduledTime(startsAt, { ...schedule, dateOverrides: [{ date: '2026-09-28', startTimes: [] }] }, now), false);
  assert.equal(isScheduledTime(startsAt, schedule, '2026-09-29T00:00:00Z'), false);
  assert.ok(isScheduledTime('2026-11-02T14:00:00Z', schedule, '2026-11-01T18:00:00Z'));
  assert.equal(isScheduledTime('2026-11-02T13:00:00Z', schedule, '2026-11-01T18:00:00Z'), false);
});
