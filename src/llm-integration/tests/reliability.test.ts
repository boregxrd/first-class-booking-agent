import assert from 'node:assert/strict';
import test from 'node:test';
import { localD1, TEST_NOW } from './fixtures.js';
import { ingest, drainInbox } from '../runtime/inbox.js';
import { D1ConversationStore } from '../conversations/d1-store.js';
import { dispatchOutbox } from '../runtime/outbox.js';
import { recoverDeliveries } from '../runtime/delivery.js';
import { ConversationBusyError } from '../runtime/persistence.js';
import type { InboundMessage } from '../../../model.js';

const identity = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: 'tester' };
const message = (id: string): InboundMessage => ({ identity, providerMessageId: id, text: `message ${id}`, sentAt: TEST_NOW, receivedAt: TEST_NOW });

test('inbox dedup, FIFO, conversation mutex, atomic outbox and safe replay', async () => {
  const { db, dispose } = await localD1();
  try {
    await ingest(db, [message('one'), message('two'), message('one')]);
    const store = new D1ConversationStore(db);
    let release!: () => void;
    let acquired!: () => void;
    const started = new Promise<void>((resolve) => { acquired = resolve; });
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const holder = store.withConversation(identity, async () => { acquired(); await blocker; });
    await started;
    await assert.rejects(store.withConversation(identity, async () => {}), ConversationBusyError);
    release(); await holder;
    const order: string[] = [];
    const processor = async (incoming: InboundMessage) => store.withConversation(incoming.identity, async (session) => {
      const replay = await session.getProcessedTurn(incoming.providerMessageId);
      if (replay) return replay;
      order.push(incoming.providerMessageId);
      const result = { reply: `reply ${incoming.providerMessageId}`, bookingStatus: 'none' as const, usage: { inputTokens: 1, outputTokens: 1 } };
      await session.complete(incoming, session.state, result);
      return result;
    });
    await Promise.all([drainInbox(db, processor, 20, TEST_NOW), drainInbox(db, processor, 20, TEST_NOW)]);
    await drainInbox(db, processor, 20, TEST_NOW);
    assert.deepEqual(order, ['one', 'two']);
    await processor(message('one'));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM outgoing_messages').first<{ n: number }>())?.n, 2);
    const sent: string[] = [];
    const now = new Date().toISOString();
    const sender = { sendText: async (_identity: unknown, text: string) => { sent.push(text); return { status: 'accepted' as const, providerMessageId: `p${sent.length}` }; } };
    await Promise.all([dispatchOutbox(db, sender, now), dispatchOutbox(db, sender, now)]);
    await dispatchOutbox(db, sender, now);
    await dispatchOutbox(db, sender, now);
    assert.deepEqual(sent, ['reply one', 'reply two']);
  } finally { await dispose(); }
});

test('outbox safely retries rejection, but never retries an ambiguous send', async () => {
  const { db, dispose } = await localD1();
  try {
    const store = new D1ConversationStore(db);
    await store.withConversation(identity, async (s) => s.complete(message('one'), s.state, { reply: 'hello', bookingStatus: 'none', usage: { inputTokens: 0, outputTokens: 0 } }));
    let calls = 0;
    const sender = { sendText: async () => { calls++; return calls === 1
      ? { status: 'rejected' as const, code: 'HTTP_429', retryable: true }
      : { status: 'unknown' as const, reason: 'timeout' }; } };
    const now = new Date().toISOString();
    await dispatchOutbox(db, sender, now);
    await dispatchOutbox(db, sender, now);
    assert.equal(calls, 1);
    const later = new Date(Date.parse(now) + 60_000).toISOString();
    await dispatchOutbox(db, sender, later);
    await dispatchOutbox(db, sender, later);
    assert.equal(calls, 2);
    assert.equal((await db.prepare('SELECT state FROM outgoing_messages').first<{ state: string }>())?.state, 'unknown');
    assert.equal((await db.prepare("SELECT count(*) AS n FROM operational_alerts WHERE kind = 'delivery_unknown'").first<{ n: number }>())?.n, 1);
    await db.prepare("UPDATE outgoing_messages SET state = 'sending', lease_expires_at = '1970-01-01'").run();
    await recoverDeliveries(db, 'outgoing_messages', now);
    assert.equal((await db.prepare('SELECT state FROM outgoing_messages').first<{ state: string }>())?.state, 'unknown');
  } finally { await dispose(); }
});

test('queue publication failure leaves a durable recoverable inbox', async () => {
  const { db, dispose } = await localD1();
  try {
    await ingest(db, [message('one')], { send: async () => { throw new Error('unavailable'); } } as unknown as Queue);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM message_inbox WHERE state = 'pending'").first<{ n: number }>())?.n, 1);
    const seen: string[] = [];
    await drainInbox(db, async (incoming) => { seen.push(incoming.providerMessageId); throw new Error('model failure'); }, 20, TEST_NOW);
    await ingest(db, [message('two')]);
    await drainInbox(db, async (incoming) => { seen.push(incoming.providerMessageId); throw new Error('model failure'); }, 20, TEST_NOW);
    assert.deepEqual(seen, ['one'], 'later turns cannot overtake a failed earlier turn');
  } finally { await dispose(); }
});

test('an expired conversation writer cannot commit history or an outgoing reply', async () => {
  const { db, dispose } = await localD1();
  try {
    const store = new D1ConversationStore(db);
    await assert.rejects(store.withConversation(identity, async (session) => {
      await db.prepare("UPDATE processing_leases SET expires_at = '1970-01-01'").run();
      await session.complete(message('stale'), session.state, { reply: 'must not send', bookingStatus: 'none', usage: { inputTokens: 0, outputTokens: 0 } });
    }));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM outgoing_messages').first<{ n: number }>())?.n, 0);
    await store.withConversation(identity, async (session) => {
      await session.complete(message('recovered'), session.state, { reply: 'okay', bookingStatus: 'none', usage: { inputTokens: 0, outputTokens: 0 } });
    });
    assert.equal((await db.prepare('SELECT count(*) AS n FROM outgoing_messages').first<{ n: number }>())?.n, 1);
  } finally { await dispose(); }
});
