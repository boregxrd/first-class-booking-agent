import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createDirectChatRoutes } from '../webhooks/direct-chat.js';
import { localD1, FakeRosterCalendar, TEST_NOW, TEST_SLOT } from './fixtures.js';
import { D1ConversationStore } from '../conversations/d1-store.js';
import { D1BookingService } from '../../bookings/service.js';
import { createConversationProcessor } from '../conversations/processor.js';
import { DIRECT_CHAT_ACCOUNT } from '../runtime/direct-chat.js';
import { ModelRequestError } from '../agent/client.js';
import type { Env } from '../../types/env.js';

test('direct chat authentication and validation run before invoking services', async () => {
  let calls = 0;
  const app = new Hono<{ Bindings: Env }>().route('/test/chat', createDirectChatRoutes(() => { calls++; throw new Error('Unexpected call'); }));
  const env: Env = { META_APP_SECRET: '', META_VERIFY_TOKEN: '', DIRECT_CHAT_TOKEN: 'private-test-token' };
  const request = (authorization?: string, body = '{}') => app.request('/test/chat', { method: 'POST', headers: authorization ? { Authorization: authorization } : {}, body }, env);
  assert.equal((await request()).status, 401);
  assert.equal((await request('Bearer wrong')).status, 401);
  assert.equal((await request('Bearer private-test-token')).status, 400);
  assert.equal((await request('Bearer private-test-token', 'x'.repeat(25 * 1024))).status, 413);
  assert.equal((await request('Bearer private-test-token', JSON.stringify({ conversationId: 'ana', messageId: 'turn', text: 'hello' }))).status, 503);
  env.DIRECT_CHAT_TOKEN = undefined;
  assert.equal((await request()).status, 404);
  assert.equal(calls, 0);
});

test('direct chat persists confirmed bookings and isolates replies/notifications, including replay across conversation IDs', async () => {
  const { db, dispose } = await localD1();
  try {
    const calendar = new FakeRosterCalendar();
    const bookings = new D1BookingService(db, calendar, () => TEST_NOW);
    let modelCalls = 0;
    const processor = createConversationProcessor({ store: new D1ConversationStore(db), bookings, now: () => TEST_NOW,
      model: { complete: async (messages) => {
        modelCalls++;
        const name = messages.at(-1)!.content!;
        return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'proposal', type: 'function', function: {
          name: 'proposeTrial', arguments: JSON.stringify({ name, phone: '+12145550101', instagramHandle: null, startsAt: TEST_SLOT }),
        } }] }, usage: { inputTokens: 10, outputTokens: 5 } };
      } },
    });
    const app = new Hono<{ Bindings: Env }>().route('/test/chat', createDirectChatRoutes(() => ({ processor, bookings, calendarClient: calendar })));
    const env: Env = { META_APP_SECRET: '', META_VERIFY_TOKEN: '', DB: db, DIRECT_CHAT_TOKEN: 'test',
      OPENAI_API_KEY: 'configured', GOOGLE_CALENDAR_ID: 'configured', GOOGLE_CLIENT_EMAIL: 'configured', GOOGLE_PRIVATE_KEY: 'configured' };
    const send = async (conversationId: string, messageId: string, text: string) => {
      const response = await app.request('/test/chat', { method: 'POST', headers: { Authorization: 'Bearer test' }, body: JSON.stringify({ conversationId, messageId, text }) }, env);
      assert.equal(response.status, 200);
      return response.json() as Promise<{ reply: string; bookingStatus: string; booking: { id: string }; calendarEvent: { description: string } }>;
    };
    for (const name of ['Ana', 'Sofia']) {
      assert.equal((await send(name, 'details', name)).bookingStatus, 'awaiting_confirmation');
      const confirmed = await send(name, 'confirm', 'sí confirmo');
      assert.equal(confirmed.bookingStatus, 'confirmed');
      assert.ok(confirmed.calendarEvent.description.includes(name));
      const replay = await send(name, 'confirm', 'sí confirmo');
      assert.equal(replay.reply, confirmed.reply);
      assert.equal(replay.booking.id, confirmed.booking.id);
    }
    assert.equal(modelCalls, 2);
    assert.equal(calendar.events.size, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM bookings').first<{ n: number }>())?.n, 2);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM outgoing_messages').first<{ n: number }>())?.n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM notification_jobs').first<{ n: number }>())?.n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM consents WHERE source_business_account_id = ?').bind(DIRECT_CHAT_ACCOUNT).first<{ n: number }>())?.n, 2);
  } finally { await dispose(); }
});

test('direct chat reports provider errors without exposing provider details', async () => {
  const { db, dispose } = await localD1();
  try {
    const app = new Hono<{ Bindings: Env }>().route('/test/chat', createDirectChatRoutes(() => ({
      processor: async () => { throw new ModelRequestError(429, true); },
      bookings: new D1BookingService(db, null), calendarClient: null,
    })));
    const env: Env = { META_APP_SECRET: '', META_VERIFY_TOKEN: '', DB: db, DIRECT_CHAT_TOKEN: 'test',
      OPENAI_API_KEY: 'configured', GOOGLE_CALENDAR_ID: 'configured', GOOGLE_CLIENT_EMAIL: 'configured', GOOGLE_PRIVATE_KEY: 'configured' };
    const response = await app.request('/test/chat', { method: 'POST', headers: { Authorization: 'Bearer test' },
      body: JSON.stringify({ conversationId: 'ana', messageId: 'turn', text: 'hello' }) }, env);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'OpenAI request failed', providerStatus: 429, retryable: true });
  } finally { await dispose(); }
});
