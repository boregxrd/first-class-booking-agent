import assert from 'node:assert/strict';
import test from 'node:test';
import { MetaInstagramProfileReader, type InstagramProfile } from '../../channels/instagram-profile.js';
import type { Env } from '../../types/env.js';
import { D1ConversationStore } from '../conversations/d1-store.js';
import { createConversationProcessor } from '../conversations/processor.js';
import type { ModelReply } from '../agent/client.js';
import { D1BookingService } from '../../bookings/service.js';
import { FakeRosterCalendar, localD1, TEST_NOW, TEST_SLOT, seedCustomer, bookingContext } from './fixtures.js';

const identity = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: '123456' };
const env: Env = { META_APP_SECRET: 'secret', META_VERIFY_TOKEN: 'verify', META_INSTAGRAM_ACCOUNT_ID: 'gym', META_INSTAGRAM_ACCESS_TOKEN: 'instagram-token', META_GRAPH_API_VERSION: 'v26.0' };
const tool = (name: string, args: unknown = {}): ModelReply => ({
  message: { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  usage: { inputTokens: 1, outputTokens: 1 },
});
const proposal = (name: string) => tool('proposeTrial', { name, phone: null, instagramHandle: 'model.invented.handle', startsAt: TEST_SLOT });
const text = (content: string): ModelReply => ({ message: { role: 'assistant', content }, usage: { inputTokens: 1, outputTokens: 1 } });

test('profile reader uses Instagram Login and validates the scoped identity without leaking tokens into URLs', async () => {
  let calls = 0;
  const reader = new MetaInstagramProfileReader(env, async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://graph.instagram.com/v26.0/123456?fields=id%2Cname%2Cusername');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer instagram-token');
    assert.ok(options?.signal);
    return Response.json({ id: '123456', name: ' Manu ', username: 'boregxrd' });
  });
  assert.deepEqual(await reader.getProfile(identity), { name: 'Manu', username: 'boregxrd' });
  assert.equal(await reader.getProfile({ ...identity, businessAccountId: 'other-gym' }), null);
  assert.equal(await reader.getProfile({ ...identity, channel: 'whatsapp' }), null);
  assert.equal(await reader.getProfile({ ...identity, businessAccountId: 'internal-direct-chat' }), null);
  assert.equal(calls, 1);
});

test('denied, timed-out, invalid and wrong-user profiles fall back without blocking a DM', async () => {
  for (const request of [
    async () => new Response('denied', { status: 403 }),
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
    async () => new Response('not JSON'),
    async () => Response.json({ id: 'someone-else', name: 'Manu', username: 'boregxrd' }),
    async () => Response.json({ id: identity.senderId, name: 'Manu', username: 'invalid handle' }),
  ]) assert.equal(await new MetaInstagramProfileReader(env, request).getProfile(identity), null);
  assert.deepEqual(await new MetaInstagramProfileReader(env, async () => Response.json({ id: identity.senderId, username: 'boregxrd' })).getProfile(identity), { name: null, username: 'boregxrd' });
  assert.equal(await new MetaInstagramProfileReader({ ...env, META_INSTAGRAM_TOKEN_EXPIRES_AT: '2020-01-01T00:00:00Z' }, async () => { throw new Error('must not call'); }).getProfile(identity), null);
});

async function conversation(responses: ModelReply[], profile: InstagramProfile | null = { name: 'Manu', username: 'boregxrd' }) {
  const { db, dispose } = await localD1();
  const store = new D1ConversationStore(db);
  const calendar = new FakeRosterCalendar();
  const bookings = new D1BookingService(db, calendar, () => TEST_NOW);
  let profileCalls = 0;
  let clock = TEST_NOW;
  const requests: string[] = [];
  const process = createConversationProcessor({
    bookings, store, now: () => clock,
    getInstagramProfile: async () => { profileCalls++; return profile; },
    model: { complete: async (messages) => {
      requests.push(JSON.stringify(messages));
      const result = responses.shift();
      assert.ok(result, 'unexpected model invocation');
      return result;
    } },
  });
  let index = 0;
  return { db, dispose, store, calendar, requests,
    get profileCalls() { return profileCalls; },
    setClock: (value: string) => { clock = value; },
    send: (body: string) => process({ identity, text: body, providerMessageId: `message-${++index}`, receivedAt: clock, sentAt: clock }),
  };
}

test('profile Manu is proposed, corrected to Manuel, and books with the automatic handle and no phone', async () => {
  const f = await conversation([tool('requestBookingName'), proposal('Manuel')]);
  try {
    const question = await f.send('Quiero reservar el lunes a las 8');
    assert.match(question.reply, /“Manu”.*nombre para tu reserva/);
    assert.equal(f.calendar.writes, 0);
    assert.equal((await f.db.prepare('SELECT name FROM customers').first<{ name: string | null }>())?.name, null);
    const summary = await f.send('Prefiero Manuel, mi nombre es Manuel, no tengo teléfono');
    assert.equal(summary.bookingStatus, 'awaiting_confirmation');
    assert.match(summary.reply, /Manuel\nInstagram: @boregxrd/);
    assert.doesNotMatch(summary.reply, /WhatsApp|model.invented/);
    assert.equal((await f.send('sí confirmo')).bookingStatus, 'confirmed');
    assert.deepEqual(await f.db.prepare('SELECT name, instagram_handle, whatsapp_phone FROM customers').first(), {
      name: 'Manuel', instagram_handle: 'boregxrd', whatsapp_phone: null,
    });
    assert.equal(f.profileCalls, 1, 'profile cached across persisted conversation turns');
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM notification_jobs').first<{ n: number }>())?.n, 0);
    assert.ok(f.requests[0]?.includes('unconfirmedProfileName'));
  } finally { await f.dispose(); }
});

test('a model cannot silently use the profile alias; confirming it only approves the name, not the booking', async () => {
  const f = await conversation([proposal('Manu'), proposal('Manu')]);
  try {
    assert.equal((await f.send('Quiero reservar el lunes a las 8, no tengo teléfono')).bookingStatus, 'none');
    await f.store.withConversation(identity, async ({ state }) => {
      assert.equal(state.proposal, null);
      assert.equal(state.instagramProfile?.pendingName, 'Manu');
      assert.equal(state.customer.name, null);
    });
    const summary = await f.send('Sí');
    assert.equal(summary.bookingStatus, 'awaiting_confirmation');
    assert.equal(f.calendar.writes, 0, 'a name confirmation cannot authorize a booking');
    assert.equal((await f.send('sí confirmo')).bookingStatus, 'confirmed');
    assert.equal((await f.db.prepare('SELECT name FROM customers').first<{ name: string }>())?.name, 'Manu');
  } finally { await f.dispose(); }
});

test('declaring a name explicitly avoids an unnecessary profile-name confirmation', async () => {
  const f = await conversation([proposal('Manu')]);
  try {
    assert.equal((await f.send('Me llamo Manu y quiero reservar el lunes a las 8, no tengo teléfono')).bookingStatus, 'awaiting_confirmation');
  } finally { await f.dispose(); }
});

test('name rejection and an expired name question never save the profile name as confirmed', async () => {
  for (const answer of ['No', 'Sí']) {
    const f = await conversation([tool('requestBookingName'), text('¿Qué nombre prefieres?')]);
    try {
      await f.send('Quiero reservar el lunes a las 8');
      if (answer === 'Sí') f.setClock('2026-09-27T13:00:00.000Z');
      await f.send(answer);
      await f.store.withConversation(identity, async ({ state }) => {
        assert.equal(state.customer.name, null);
        assert.equal(state.instagramProfile?.pendingName, null);
      });
      assert.equal(f.calendar.writes, 0);
    } finally { await f.dispose(); }
  }
});

test('profile lookup failure asks for name and phone without a fictitious Instagram contact label', async () => {
  const f = await conversation([tool('requestBookingName'), proposal('Manuel'), proposal('Manuel')], null);
  try {
    assert.equal((await f.send('Quiero reservar el lunes a las 8')).reply, '¿A qué nombre hacemos tu reserva?');
    assert.match((await f.send('Mi nombre es Manuel')).reply, /número de WhatsApp/);
    const summary = await f.send('+12145550101');
    assert.match(summary.reply, /WhatsApp: \+12145550101/);
    assert.doesNotMatch(summary.reply, /model.invented|123456|este chat/);
    assert.equal((await f.send('sí confirmo')).bookingStatus, 'confirmed');
    assert.equal(f.profileCalls, 1, 'failed lookup is also cached to avoid delaying every reply');
    assert.equal((await f.db.prepare('SELECT instagram_handle FROM customers').first<{ instagram_handle: string | null }>())?.instagram_handle, null);
  } finally { await f.dispose(); }
});

test('a synthetic direct-chat identity cannot replace a real contact for booking', async () => {
  const { db, dispose } = await localD1();
  try {
    await seedCustomer(db, 'synthetic', null, null);
    await db.prepare(`INSERT INTO channel_identities (channel, business_account_id, sender_id, customer_id, created_at, updated_at)
      VALUES ('instagram', 'internal-direct-chat', 'sender', 'synthetic', ?, ?)`).bind(TEST_NOW, TEST_NOW).run();
    const result = await new D1BookingService(db, new FakeRosterCalendar(), () => TEST_NOW).bookTrial(bookingContext('synthetic'), { startsAt: TEST_SLOT });
    assert.equal(result.status === 'failed' && result.code, 'missing_customer_details');
  } finally { await dispose(); }
});

test('a separately supplied name is persisted and a redundant name tool cannot ask for it again', async () => {
  const f = await conversation([tool('requestBookingName'), text('¿Cuál es tu número de WhatsApp?'), proposal('Alicia')], null);
  try {
    assert.match((await f.send('quiero 8 am')).reply, /Qué día/);
    assert.equal((await f.send('el lunes')).reply, '¿A qué nombre hacemos tu reserva?');
    assert.match((await f.send('Alicia')).reply, /número de WhatsApp/);
    await f.store.withConversation(identity, async ({ state }) => assert.equal(state.customer.name, 'Alicia'));
    const summary = await f.send('+12145550101');
    assert.equal(summary.bookingStatus, 'awaiting_confirmation');
    assert.match(summary.reply, /Alicia\nWhatsApp/);
    assert.equal(f.calendar.writes, 0);
  } finally { await f.dispose(); }
});
