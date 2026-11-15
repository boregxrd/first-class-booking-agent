import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountStore } from '../../accounts/store.js';
import { saveMessagingConnection } from '../../accounts/connections.js';
import { bootstrapLegacyAccounts, reminderEnvironment } from '../../accounts/runtime.js';
import { D1BookingService } from '../../bookings/service.js';
import { D1NotificationScheduler } from '../../notifications/scheduler.js';
import { MetaTextSender } from '../../channels/outbound.js';
import { processMetaWebhook } from '../../channels/meta.js';
import { Hono } from 'hono';
import { createAccountRoutes } from '../../accounts/routes.js';
import type { Env } from '../../types/env.js';
import { FakeRosterCalendar, localD1, seedCustomer, bookingContext, TEST_NOW, TEST_SLOT } from './fixtures.js';

function environment(db: D1Database): Env {
  return { DB: db, META_APP_SECRET: 'secret', META_VERIFY_TOKEN: 'verify', META_GRAPH_API_VERSION: 'v26.0', META_MESSAGING_MODE: 'live',
    MULTI_ACCOUNT_ENABLED: 'true', ACCOUNT_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), ACCOUNT_CREDENTIAL_ACTIVE_KEY: 'v1' };
}
async function trainer(env: Env, id: string) {
  const profile = await new AccountStore(env.DB!).create({ name: id, email: `${id}@example.com` });
  await env.DB!.prepare("UPDATE distribuidoras SET google_calendar_id=?,calendar_setup_status='ready' WHERE id=?").bind(`cal-${id}`, profile.id).run();
  const accountId = await saveMessagingConnection(env, 'instagram', profile.id, { providerAccountId: id, handle: `trainer.${id}`, credentials: { accessToken: `token-${id}` } });
  return { id: profile.id, accountId, calendarId: `cal-${id}` };
}

test('two trainer calendars isolate rosters; saved attribution survives rerouting, disconnect, recovery and cancellation', async () => {
  const { db, dispose } = await localD1();
  try {
    const env = environment(db), a = await trainer(env, 'a'), b = await trainer(env, 'b');
    const calendars = new Map<string, FakeRosterCalendar>();
    for (const id of [a.calendarId, b.calendarId, 'general', 'replacement']) { const calendar = new FakeRosterCalendar(); calendar.configuredCalendarId = id; calendars.set(id, calendar); }
    const resolver = (id: string) => calendars.get(id) ?? null;
    const service = (owner: typeof a) => new D1BookingService(db, resolver(owner.calendarId), () => TEST_NOW,
      { calendarForId: resolver, distribuidoraId: owner.id, socialAccountId: owner.accountId, originChannel: 'instagram', originHandle: `trainer.${owner === a ? 'a' : 'b'}` });
    const sa = service(a), sb = service(b);
    await seedCustomer(db, 'ana', '+12145550101'); await seedCustomer(db, 'sofia', '+12145550102');
    const first = await sa.bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT });
    const second = await sb.bookTrial(bookingContext('sofia'), { startsAt: TEST_SLOT });
    assert.equal(first.status, 'succeeded'); assert.equal(second.status, 'succeeded');
    assert.match([...resolver(a.calendarId)!.events.values()][0]!.description!, /Name ana/);
    assert.doesNotMatch([...resolver(a.calendarId)!.events.values()][0]!.description!, /Name sofia/);
    assert.match([...resolver(b.calendarId)!.events.values()][0]!.description!, /Name sofia/);
    await seedCustomer(db, 'same-person-on-b', '+12145550101');
    const duplicate = await sb.bookTrial(bookingContext('same-person-on-b'), { startsAt: TEST_SLOT });
    assert.equal(duplicate.status === 'failed' && duplicate.code, 'already_booked');
    await new AccountStore(db).disconnect(a.accountId);
    await db.prepare('UPDATE distribuidoras SET google_calendar_id=? WHERE id=?').bind('replacement', a.id).run();
    if (first.status !== 'succeeded') throw new Error('booking failed');
    resolver(a.calendarId)!.timeoutAfterWrite = true;
    const moved = await sb.rescheduleTrial(bookingContext('ana', 'move-via-other-account'), { bookingId: first.booking.id, expectedRevision: 1, startsAt: '2026-09-28T14:00:00.000Z' });
    assert.equal(moved.status, 'pending');
    await sb.reconcilePendingOperations();
    const booking = await sb.getBooking(bookingContext('ana'), first.booking.id);
    assert.equal(booking?.calendar?.calendarId, a.calendarId);
    assert.equal(booking?.status, 'confirmed');
    const attribution = await db.prepare('SELECT distribuidora_id,social_account_id FROM bookings WHERE id=?').bind(first.booking.id).first();
    assert.deepEqual(attribution, { distribuidora_id: a.id, social_account_id: a.accountId });
    assert.equal(resolver('replacement')!.writes, 0);
    assert.equal((await sb.cancelTrial(bookingContext('ana', 'cancel'), { bookingId: first.booking.id, expectedRevision: 2 })).status, 'succeeded');
    assert.equal(resolver(b.calendarId)!.events.size, 1);
    const general = new D1BookingService(db, resolver('general'), () => TEST_NOW, { distribuidoraId: 'dwc', calendarForId: resolver });
    await seedCustomer(db, 'general-customer', '+12145550103');
    assert.equal((await general.bookTrial(bookingContext('general-customer'), { startsAt: TEST_SLOT })).status, 'succeeded');
    assert.match([...resolver('general')!.events.values()][0]!.description!, /general-customer/);
  } finally { await dispose(); }
});

test('reminders verify the saved trainer calendar but use only the gym WhatsApp sender and original handle', async () => {
  const { db, dispose } = await localD1();
  try {
    const env = environment(db), a = await trainer(env, 'a');
    await db.prepare("UPDATE distribuidoras SET google_calendar_id='general',calendar_setup_status='ready' WHERE id='dwc'").run();
    const gym = await saveMessagingConnection(env, 'whatsapp', 'dwc', { providerAccountId: 'gym-wa', handle: 'gym', credentials: { accessToken: 'gym-token' } });
    const ownWa = await saveMessagingConnection(env, 'whatsapp', a.id, { providerAccountId: 'trainer-wa', handle: 'trainer', credentials: { accessToken: 'trainer-token' } });
    const store = new AccountStore(db);
    await store.setSetting('reminder_sender_account_id', ownWa);
    assert.equal(await reminderEnvironment(env), null, 'trainer WhatsApp cannot become the central reminder sender');
    await store.setSetting('reminder_sender_account_id', gym);
    assert.equal((await reminderEnvironment(env))?.META_WHATSAPP_ACCESS_TOKEN, 'gym-token');
    const calendar = new FakeRosterCalendar(); calendar.configuredCalendarId = a.calendarId;
    const wrong = new FakeRosterCalendar(); wrong.configuredCalendarId = 'general';
    const resolver = (id: string) => id === a.calendarId ? calendar : null;
    await seedCustomer(db, 'ana');
    await new D1BookingService(db, calendar, () => TEST_NOW, { calendarForId: resolver, distribuidoraId: a.id,
      socialAccountId: a.accountId, originChannel: 'instagram', originHandle: 'trainer.a' }).bookTrial(bookingContext('ana'), { startsAt: TEST_SLOT });
    const parameters: string[][] = [];
    const scheduler = new D1NotificationScheduler(db, { sendTemplate: async (request) => { parameters.push(request.bodyParameters); return { status: 'accepted', providerMessageId: 'sent' }; } }, wrong,
      { businessAccountId: 'gym-wa', confirmationTemplate: 'confirm', reminderTemplate: 'remind', includeSource: true }, resolver);
    assert.equal(await scheduler.processDueNotifications(TEST_NOW), 1);
    assert.equal(parameters[0]?.[3], 'instagram @trainer.a');
    assert.equal((await db.prepare("SELECT business_account_id FROM notification_jobs WHERE state='accepted'").first<{ business_account_id: string }>())?.business_account_id, 'gym-wa');
  } finally { await dispose(); }
});

test('text replies select their own credentials and disconnecting one account leaves the other working', async () => {
  const { db, dispose } = await localD1(), original = globalThis.fetch;
  try {
    const env = environment(db), a = await trainer(env, 'a'); await trainer(env, 'b');
    const calls: string[] = [];
    globalThis.fetch = async (url, init) => { calls.push(`${url}:${new Headers(init?.headers).get('Authorization')}`); return Response.json({ message_id: 'reply' }); };
    const sender = new MetaTextSender(env), now = new Date().toISOString();
    const identity = (id: string) => ({ channel: 'instagram' as const, businessAccountId: id, senderId: 'customer' });
    assert.equal((await sender.sendText(identity('a'), 'hello', now)).status, 'accepted');
    assert.equal((await sender.sendText(identity('b'), 'hello', now)).status, 'accepted');
    assert.match(calls[0]!, /a\/messages:Bearer token-a$/); assert.match(calls[1]!, /b\/messages:Bearer token-b$/);
    await new AccountStore(db).disconnect(a.accountId);
    assert.equal((await sender.sendText(identity('a'), 'hello', now)).status, 'rejected');
    assert.equal((await sender.sendText(identity('b'), 'hello', now)).status, 'accepted');
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = original; await dispose(); }
});

test('owner portal APIs hide credentials and create recoverable profiles when Google is not yet authorized', async () => {
  const { db, dispose } = await localD1();
  try {
    const env = { ...environment(db), ADMIN_ORIGIN: 'https://gym.example', ADMIN_API_TOKEN: 'a'.repeat(40) };
    const app = new Hono<{ Bindings: Env }>().route('/', createAccountRoutes());
    assert.equal((await app.request('/admin/api/overview', {}, env)).status, 401);
    const headers = { Authorization: `Bearer ${env.ADMIN_API_TOKEN}`, 'Content-Type': 'application/json' };
    const create = await app.request('/admin/api/profiles', { method: 'POST', headers, body: JSON.stringify({ name: '<img src=x>', email: 'a@example.com' }) }, env);
    assert.equal(create.status, 202);
    assert.equal((await create.json() as { setupPending: boolean }).setupPending, true);
    const list = await app.request('/admin/api/overview', { headers }, env);
    assert.equal(list.status, 200);
    const overview = await list.json() as { setup: { googleOAuthConfigured: boolean } };
    assert.equal(overview.setup.googleOAuthConfigured, false);
    assert.doesNotMatch(JSON.stringify(overview), /encrypted_payload|accessToken|refreshToken/);
    const google = await app.request('/admin/api/connections/start', { method: 'POST', headers, body: JSON.stringify({ provider: 'google' }) }, env);
    assert.equal(google.status, 503);
    assert.match((await google.json() as { error: string }).error, /Google OAuth is not configured/);
    assert.equal((await app.request('/admin/api/bootstrap', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' }, env)).status, 401);
    const script = await app.request('/admin/app.js', {}, env);
    const source = await script.text();
    assert.doesNotMatch(source, /innerHTML/);
    assert.doesNotThrow(() => new Function(source), 'portal JavaScript must parse independently of the TypeScript build');
  } finally { await dispose(); }
});

test('signed webhook routing accepts each registered destination and never accepts unknown or disconnected accounts', async () => {
  const { db, dispose } = await localD1();
  try {
    const env = environment(db), a = await trainer(env, 'a'); await trainer(env, 'b');
    const body = (account: string, id: string) => JSON.stringify({ object: 'instagram', entry: [{ messaging: [{
      sender: { id: 'prospect' }, recipient: { id: account }, timestamp: Date.now(), message: { mid: id, text: 'hola' },
    }] }] });
    const send = async (account: string, id: string) => {
      const payload = body(account, id);
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.META_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))].map((value) => value.toString(16).padStart(2, '0')).join('');
      return processMetaWebhook(payload, `sha256=${signature}`, env);
    };
    assert.equal((await send('a', 'one')).status, 200);
    assert.equal((await send('b', 'two')).status, 200);
    assert.equal((await send('unknown', 'three')).status, 200);
    await new AccountStore(db).disconnect(a.accountId);
    assert.equal((await send('a', 'four')).status, 200);
    const stored = await db.prepare('SELECT business_account_id FROM message_inbox ORDER BY seq').all();
    assert.deepEqual(stored.results, [{ business_account_id: 'a' }, { business_account_id: 'b' }]);
  } finally { await dispose(); }
});

test('legacy bootstrap is repeatable and backfills old-version writes without recreating the general calendar', async () => {
  const { db, dispose } = await localD1();
  try {
    const env = { ...environment(db), GOOGLE_CALENDAR_ID: 'existing-general-calendar', META_INSTAGRAM_ACCOUNT_ID: '12345', META_INSTAGRAM_ACCESS_TOKEN: 'legacy-private-token' };
    await seedCustomer(db, 'old-version');
    await db.prepare(`INSERT INTO bookings (id,customer_id,starts_at,ends_at,status,calendar_id,created_at,updated_at)
      VALUES ('old-version-booking','old-version',?,?,'confirmed','existing-general-calendar','now','now')`).bind(TEST_SLOT, '2026-09-28T14:00:00Z').run();
    await bootstrapLegacyAccounts(env); await bootstrapLegacyAccounts(env);
    const store = new AccountStore(db);
    assert.equal((await store.get('dwc'))?.google_calendar_id, 'existing-general-calendar');
    assert.equal((await store.publicAccounts()).length, 1);
    assert.equal((await db.prepare("SELECT distribuidora_id FROM bookings WHERE id='old-version-booking'").first<{ distribuidora_id: string }>())?.distribuidora_id, 'dwc');
    const encrypted = await db.prepare('SELECT encrypted_payload FROM account_credentials').first<{ encrypted_payload: string }>();
    assert.ok(encrypted); assert.doesNotMatch(encrypted.encrypted_payload, /legacy-private-token/);
  } finally { await dispose(); }
});
