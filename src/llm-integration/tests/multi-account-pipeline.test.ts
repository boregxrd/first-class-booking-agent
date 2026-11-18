import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountStore } from '../../accounts/store.js';
import { saveMessagingConnection } from '../../accounts/connections.js';
import { processMetaWebhook } from '../../channels/meta.js';
import { handleQueue } from '../runtime/queue.js';
import { dallasDate, dallasTime } from '../conversations/intake.js';
import type { ChatMessage } from '../agent/client.js';
import type { GoogleCalendarEvent } from '../../calendar/client.js';
import type { Env } from '../../types/env.js';
import { localD1 } from './fixtures.js';
import { Hono } from 'hono';
import { createDirectChatRoutes } from '../webhooks/direct-chat.js';
import { createServices } from '../../runtime/factory.js';

function futureClass() {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' });
  for (let time = Math.ceil((Date.now() + 86_400_000) / 3_600_000) * 3_600_000; ; time += 3_600_000) {
    const instant = new Date(time).toISOString();
    if (dallasTime(instant) === '08:00' && !['Sat', 'Sun'].includes(weekday.format(new Date(instant)))) return instant;
  }
}

test('signed webhooks → production queue/factory/agent → correct trainer calendars → originating-account replies', async () => {
  const { db, dispose } = await localD1(), original = globalThis.fetch;
  try {
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
    let wakeups = 0, acknowledgements = 0, modelCalls = 0;
    const env: Env = { DB: db, META_APP_SECRET: 'test-webhook-secret', META_VERIFY_TOKEN: 'verify', META_GRAPH_API_VERSION: 'v26.0',
      META_MESSAGING_MODE: 'live', MULTI_ACCOUNT_ENABLED: 'true', OPENAI_API_KEY: 'model-test-token', DIRECT_CHAT_TOKEN: 'operator-test-token',
      META_INSTAGRAM_ACCOUNT_ID: 'wrong-legacy-account', META_INSTAGRAM_ACCESS_TOKEN: 'never-use-legacy-token',
      GOOGLE_CALENDAR_ID: 'general-calendar', GOOGLE_CLIENT_EMAIL: 'bot@example.com', GOOGLE_PRIVATE_KEY: privateKey,
      ACCOUNT_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), ACCOUNT_CREDENTIAL_ACTIVE_KEY: 'v1',
      MESSAGE_QUEUE: { send: async () => { wakeups++; } } as unknown as Queue };
    const store = new AccountStore(db);
    const a = await store.create({ name: 'Trainer A', email: 'a@example.com' });
    const b = await store.create({ name: 'Trainer B', email: 'b@example.com' });
    const cases = [
      { name: 'Ana', sender: '1001', account: '2001', owner: a.id, calendar: 'trainer-a-calendar', handle: 'trainer.a', phone: '+12145550101' },
      { name: 'Sofia', sender: '1002', account: '2002', owner: b.id, calendar: 'trainer-b-calendar', handle: 'trainer.b', phone: '+12145550102' },
      { name: 'Clara', sender: '1003', account: '2000', owner: 'dwc', calendar: 'general-calendar', handle: 'dwc', phone: '+12145550103' },
    ];
    for (const item of cases) {
      await db.prepare("UPDATE distribuidoras SET google_calendar_id=?,calendar_setup_status='ready' WHERE id=?").bind(item.calendar, item.owner).run();
      await saveMessagingConnection(env, 'instagram', item.owner, { providerAccountId: item.account, handle: item.handle,
        credentials: { accessToken: `account-token-${item.account}` } });
    }
    const startsAt = futureClass();
    const events = new Map<string, Map<string, GoogleCalendarEvent>>();
    const outgoing: Array<{ account: string; to: string; text: string }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)), headers = new Headers(init?.headers);
      if (url.hostname === 'api.openai.com') {
        modelCalls++;
        const request = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
        const context = request.messages.find((entry) => entry.role === 'tool' && entry.tool_call_id === 'customer-context');
        assert.ok(context);
        const details = JSON.parse(context.content!);
        if (!details.confirmedName) return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '¿A qué nombre hacemos tu reserva?' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 } });
        assert.ok(cases.some((item) => item.name === details.confirmedName) || details.confirmedName === 'Operator Test');
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: `proposal-${modelCalls}`, type: 'function', function: { name: 'proposeTrial', arguments: JSON.stringify({
            name: details.confirmedName, phone: null, instagramHandle: details.instagramDm ? 'ignored' : null, startsAt,
          }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      if (url.hostname === 'oauth2.googleapis.com') {
        assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        return Response.json({ access_token: 'calendar-service-token', expires_in: 3600 });
      }
      if (url.hostname === 'www.googleapis.com') {
        assert.equal(headers.get('Authorization'), 'Bearer calendar-service-token');
        const parts = url.pathname.split('/').map(decodeURIComponent), calendarId = parts[4]!, eventId = parts[6];
        assert.ok(cases.some((item) => item.calendar === calendarId), `unexpected calendar ${calendarId}`);
        let calendar = events.get(calendarId);
        if (!calendar) { calendar = new Map(); events.set(calendarId, calendar); }
        if (!init?.method || init.method === 'GET') {
          const event = calendar.get(eventId!);
          return event ? Response.json(event) : new Response(null, { status: 404 });
        }
        const body = JSON.parse(String(init.body)) as GoogleCalendarEvent;
        assert.ok(init.method === 'POST' || init.method === 'PATCH');
        if (init.method === 'POST') assert.equal(calendar.has(body.id), false);
        else assert.equal(headers.get('If-Match'), calendar.get(body.id)?.etag);
        const event = { ...body, etag: init.method === 'POST' ? '"v1"' : '"v2"' }; calendar.set(body.id, event);
        return Response.json(event);
      }
      if (url.hostname === 'graph.instagram.com') {
        const id = url.pathname.split('/')[2]!;
        if (url.pathname.endsWith('/messages')) {
          const item = cases.find((entry) => entry.account === id);
          assert.ok(item);
          assert.equal(headers.get('Authorization'), `Bearer account-token-${item.account}`);
          const body = JSON.parse(String(init?.body));
          assert.equal(body.recipient.id, item.sender);
          outgoing.push({ account: id, to: body.recipient.id, text: body.message.text });
          return Response.json({ message_id: `outgoing-${outgoing.length}` });
        }
        const item = cases.find((entry) => entry.sender === id);
        assert.ok(item);
        assert.equal(headers.get('Authorization'), `Bearer account-token-${item.account}`);
        return Response.json({ id, name: 'Unconfirmed profile alias', username: `prospect.${id}` });
      }
      throw new Error(`Unexpected transport ${url.origin}${url.pathname}`);
    };
    const receive = async (confirm: boolean) => {
      const payload = JSON.stringify({ object: 'instagram', entry: [{ messaging: cases.map((item) => ({
        sender: { id: item.sender }, recipient: { id: item.account }, timestamp: Date.now(),
        operatorTestAccountId: 'instagram:2002', // Untrusted webhook extensions must not select another account.
        message: { mid: `${confirm ? 'confirm' : 'details'}-${item.sender}`, text: confirm ? 'sí'
          : `Soy ${item.name}, quiero reservar el ${dallasDate(startsAt)} a las 08:00, ${item.phone}` },
      })) }] });
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.META_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))].map((value) => value.toString(16).padStart(2, '0')).join('');
      assert.equal((await processMetaWebhook(payload, `sha256=${signature}`, env)).status, 200);
      await handleQueue({ queue: 'dwc-messages', messages: [], metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        ackAll: () => { acknowledgements++; }, retryAll: () => {} }, env);
    };
    await receive(false);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM bookings').first<{ n: number }>())?.n, 0, 'no booking before customer approval');
    assert.equal(outgoing.length, 3);
    await receive(true);
    assert.equal(wakeups, 2); assert.equal(acknowledgements, 2); assert.equal(modelCalls, 3);
    assert.equal(outgoing.length, 6);
    for (const item of cases) {
      const rows = await db.prepare(`SELECT b.calendar_id,b.distribuidora_id,b.social_account_id,b.origin_handle,b.status,c.name
        FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE c.name=?`).bind(item.name).all();
      assert.deepEqual(rows.results, [{ calendar_id: item.calendar, distribuidora_id: item.owner,
        social_account_id: `instagram:${item.account}`, origin_handle: item.handle, status: 'confirmed', name: item.name }]);
      const calendar = events.get(item.calendar)!;
      assert.equal(calendar.size, 1);
      const roster = [...calendar.values()][0]!.description!;
      assert.match(roster, new RegExp(item.name));
      for (const other of cases.filter((entry) => entry !== item)) assert.doesNotMatch(roster, new RegExp(other.name));
      assert.equal(outgoing.filter((entry) => entry.account === item.account && entry.to === item.sender && entry.text.includes('está confirmada')).length, 1);
    }
    assert.equal((await db.prepare("SELECT count(*) AS n FROM message_inbox WHERE state='processed'").first<{ n: number }>())?.n, 6);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM outgoing_messages WHERE state='accepted'").first<{ n: number }>())?.n, 6);
    const app = new Hono<{ Bindings: Env }>().route('/test/chat', createDirectChatRoutes());
    const now = new Date().toISOString();
    await assert.rejects(createServices(env).processor({ identity: { channel: 'instagram', businessAccountId: '2001', senderId: '1001' },
      providerMessageId: 'forged-operator-target', text: 'integration test', sentAt: now, receivedAt: now, operatorTestAccountId: 'instagram:2002' }), /protected direct-chat namespace/);
    const sendOperator = (messageId: string, text: string, authenticated = true) => app.request('/test/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer operator-test-token' } : {}) },
      body: JSON.stringify({ conversationId: 'operator-routing', messageId, text, targetSocialAccountId: 'instagram:2001' }) }, env);
    assert.equal((await sendOperator('denied', 'hola', false)).status, 401);
    const details = await sendOperator('details', `Soy Operator Test, quiero reservar el ${dallasDate(startsAt)} a las 08:00, +12145550199`);
    assert.equal(details.status, 200);
    assert.equal((await details.json() as { bookingStatus: string }).bookingStatus, 'awaiting_confirmation');
    const missingTarget = await app.request('/test/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer operator-test-token' },
      body: JSON.stringify({ conversationId: 'operator-routing', messageId: 'confirmation', text: 'sí' }) }, env);
    assert.equal((await missingTarget.json() as { bookingStatus: string }).bookingStatus, 'none', 'omitting a target cannot approve its proposal in the general calendar');
    const confirmed = await sendOperator('confirmation', 'sí');
    assert.equal(confirmed.status, 200);
    const result = await confirmed.json() as { bookingStatus: string; operatorTest: boolean; booking: { calendar: { calendarId: string } }; calendarEvent: { description: string } };
    assert.equal(result.bookingStatus, 'confirmed'); assert.equal(result.operatorTest, true);
    assert.equal(result.booking.calendar.calendarId, cases[0]!.calendar);
    assert.match(result.calendarEvent.description, /Operator Test/);
    assert.doesNotMatch(result.calendarEvent.description, /Clara/);
    assert.equal(outgoing.length, 6, 'operator test replies must never be sent to Meta');
    const operatorBooking = await db.prepare("SELECT distribuidora_id,social_account_id,origin_channel FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE c.name='Operator Test'").first();
    assert.deepEqual(operatorBooking, { distribuidora_id: a.id, social_account_id: 'instagram:2001', origin_channel: 'operator_test' });
    assert.equal((await db.prepare("SELECT count(*) AS n FROM notification_jobs j JOIN bookings b ON b.id=j.booking_id JOIN customers c ON c.id=b.customer_id WHERE c.name='Operator Test'").first<{ n: number }>())?.n, 0);
  } finally { globalThis.fetch = original; await dispose(); }
});
