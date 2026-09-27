import assert from 'node:assert/strict';
import test from 'node:test';
import { localD1, FakeRosterCalendar, TEST_NOW, TEST_SLOT } from './fixtures.js';
import { D1BookingService } from '../../bookings/service.js';
import { D1ConversationStore } from '../conversations/d1-store.js';
import { D1ConversationControls } from '../conversations/controls.js';
import { createConversationProcessor } from '../conversations/processor.js';
import { ingest, drainInbox, resumeCompletedActions } from '../runtime/inbox.js';
import { dispatchOutbox } from '../runtime/outbox.js';
import { maintainState } from '../../runtime/maintenance.js';
import type { InboundMessage } from '../../../model.js';

test('two real D1 conversations: inbox → agent → confirmation → shared roster → separate replies', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar();
    const store = new D1ConversationStore(db);
    const processor = createConversationProcessor({ store, bookings: new D1BookingService(db, calendar, () => TEST_NOW),
      controls: new D1ConversationControls(db), now: () => TEST_NOW, model: { complete: async (messages) => {
        const name = messages.at(-1)!.content!;
        return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'proposal', type: 'function', function: { name: 'proposeTrial',
          arguments: JSON.stringify({ name, instagramHandle: `@${name.toLowerCase()}`, phone: null, startsAt: TEST_SLOT }) } }] }, usage: { inputTokens: 10, outputTokens: 10 } };
      } } });
    const input = (name: string, id: string, text: string): InboundMessage => ({ identity: { channel: 'instagram', businessAccountId: 'gym', senderId: name },
      providerMessageId: id, text, sentAt: TEST_NOW, receivedAt: TEST_NOW });
    const messages = [input('Ana', 'ana-details', 'Ana'), input('Sofia', 'sofia-details', 'Sofia'), input('Ana', 'ana-confirm', 'sí confirmo'), input('Sofia', 'sofia-confirm', 'sí confirmo')];
    await ingest(db, messages);
    await ingest(db, messages);
    await drainInbox(db, processor, 20, TEST_NOW);
    assert.equal(calendar.events.size, 1);
    const roster = [...calendar.events.values()][0]!.description!;
    assert.match(roster, /Ana/); assert.match(roster, /Sofia/);
    const replies: Array<{ to: string; text: string }> = [];
    const sender = { sendText: async (identity: { senderId: string }, text: string) => {
      replies.push({ to: identity.senderId, text }); return { status: 'accepted' as const, providerMessageId: String(replies.length) };
    } };
    const now = new Date().toISOString();
    await dispatchOutbox(db, sender, now); await dispatchOutbox(db, sender, now); await dispatchOutbox(db, sender, now);
    assert.equal(replies.length, 4);
    assert.equal(replies.filter((reply) => reply.to === 'Ana' && reply.text.includes('está confirmada')).length, 1);
    assert.equal(replies.filter((reply) => reply.to === 'Sofia' && reply.text.includes('está confirmada')).length, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM notification_jobs').first<{ n: number }>())?.n, 0);
  } finally { await dispose(); }
});

test('retention removes old text but retains pending work and booking records', async () => {
  const { db, dispose } = await localD1();
  try {
    const old = '2000-01-01T00:00:00.000Z';
    const input: InboundMessage = { identity: { channel: 'instagram', businessAccountId: 'gym', senderId: 'tester' }, providerMessageId: 'old', text: 'private text', sentAt: old, receivedAt: old };
    await ingest(db, [input, { ...input, providerMessageId: 'pending' }]);
    await new D1ConversationStore(db).withConversation(input.identity, async (session) => {
      await session.complete(input, session.state, { reply: 'private reply', bookingStatus: 'none', usage: { inputTokens: 0, outputTokens: 0 } });
    });
    await db.prepare('UPDATE messages SET created_at = ?').bind(old).run();
    await db.prepare("UPDATE outgoing_messages SET state = 'accepted', updated_at = ?").bind(old).run();
    await maintainState(db, { META_APP_SECRET: 'test', META_VERIFY_TOKEN: 'test' }, TEST_NOW);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM messages').first<{ n: number }>())?.n, 0);
    assert.equal((await db.prepare("SELECT payload FROM message_inbox WHERE provider_message_id = 'old'").first<{ payload: string }>())?.payload, '{}');
    assert.match((await db.prepare("SELECT payload FROM message_inbox WHERE provider_message_id = 'pending'").first<{ payload: string }>())!.payload, /private text/);
    assert.equal((await db.prepare('SELECT text FROM outgoing_messages').first<{ text: string }>())?.text, '');
  } finally { await dispose(); }
});

test('a pending authorized booking sends its final reply after reconciliation, without another customer DM', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar();
    const bookings = new D1BookingService(db, calendar, () => TEST_NOW);
    const processor = createConversationProcessor({ store: new D1ConversationStore(db), bookings, now: () => TEST_NOW,
      model: { complete: async () => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'proposal', type: 'function', function: {
        name: 'proposeTrial', arguments: JSON.stringify({ name: 'Ana', phone: null, instagramHandle: '@ana', startsAt: TEST_SLOT }),
      } }] }, usage: { inputTokens: 1, outputTokens: 1 } }) } });
    const identity = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: 'ana' };
    const incoming = (id: string, text: string): InboundMessage => ({ identity, providerMessageId: id, text, sentAt: TEST_NOW, receivedAt: TEST_NOW });
    await ingest(db, [incoming('details', 'Quiero reservar')]); await drainInbox(db, processor, 20, TEST_NOW);
    calendar.timeoutAfterWrite = true;
    await ingest(db, [incoming('confirm', 'sí confirmo')]); await drainInbox(db, processor, 20, TEST_NOW);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM booking_operations WHERE status = 'pending'").first<{ n: number }>())?.n, 1);
    await bookings.reconcilePendingOperations();
    await resumeCompletedActions(db, processor, TEST_NOW); await resumeCompletedActions(db, processor, TEST_NOW);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM outgoing_messages WHERE source_message_id LIKE 'operation-completed:%' AND text LIKE '¡Lista,%'").first<{ n: number }>())?.n, 1);
  } finally { await dispose(); }
});
