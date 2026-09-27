import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarApiError, GoogleCalendarClient } from './client.js';
import { buildRosterEvent, deriveSlotRosterEventId, syncSlotRoster, type ProspectSlotEntry } from './slot-roster.js';
import { FakeRosterCalendar, TEST_SLOT } from '../llm-integration/tests/fixtures.js';

const prospect: ProspectSlotEntry = { bookingId: 'booking-1', name: 'Ana', phone: '+12145550101', instagramHandle: null, language: 'es' };

test('slot IDs normalize offsets and different dates/hours produce different event IDs', async () => {
  const first = await deriveSlotRosterEventId(TEST_SLOT);
  assert.match(first, /^[a-v0-9]{5,1024}$/);
  assert.equal(first, await deriveSlotRosterEventId('2026-09-28T08:00:00-05:00'));
  assert.notEqual(first, await deriveSlotRosterEventId('2026-09-28T14:00:00Z'));
  assert.notEqual(first, await deriveSlotRosterEventId('2026-11-02T14:00:00Z'));
});

test('roster description contains full details, deduplicates booking IDs and keeps empty events', async () => {
  const calendar = new FakeRosterCalendar();
  const event = await syncSlotRoster(calendar, TEST_SLOT, async () => [prospect, prospect]);
  assert.equal(event.end.dateTime, '2026-09-28T14:00:00.000Z');
  assert.match(event.description!, /Prospects \(1\)/);
  assert.match(event.description!, /Name|Ana/);
  assert.match(event.description!, /2640 Old Denton/);
  assert.match(event.description!, /Phone: \+12145550101/);
  assert.match(event.description!, /Language: es/);
  const empty = await syncSlotRoster(calendar, TEST_SLOT, async () => []);
  assert.equal(empty.id, event.id);
  assert.match(empty.description!, /Prospects \(0\)/);
});

test('CAS conflict reloads the source roster instead of losing a concurrent prospect', async () => {
  const calendar = new FakeRosterCalendar();
  await syncSlotRoster(calendar, TEST_SLOT, async () => [prospect]);
  let loads = 0;
  const realReplace = calendar.replaceRoster.bind(calendar);
  calendar.replaceRoster = async (body, etag) => {
    if (loads === 1) throw new CalendarApiError(412);
    return realReplace(body, etag);
  };
  const final = await syncSlotRoster(calendar, TEST_SLOT, async () => {
    loads++;
    return loads === 1 ? [prospect] : [prospect, { ...prospect, bookingId: 'booking-2', name: 'Sofia', phone: null, instagramHandle: '@sofia' }];
  });
  assert.equal(loads, 2);
  assert.match(final.description!, /Ana/); assert.match(final.description!, /Sofia/);
});

test('externally moved/deleted events are not silently overwritten', async () => {
  const calendar = new FakeRosterCalendar();
  const event = await syncSlotRoster(calendar, TEST_SLOT, async () => [prospect]);
  calendar.events.set(event.id, { ...event, status: 'cancelled' });
  await assert.rejects(syncSlotRoster(calendar, TEST_SLOT, async () => []), /modified externally/);
});

test('Google transport inserts on collection and uses If-Match for roster patches', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const key = await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer;
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(key)))}\n-----END PRIVATE KEY-----`;
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }));
    methods.push(init?.method ?? 'GET');
    if (init?.method === 'POST') assert.ok(String(url).endsWith('/events'));
    if (init?.method === 'PATCH') assert.equal(new Headers(init.headers).get('If-Match'), '"1"');
    return new Response(JSON.stringify({ ...JSON.parse(init!.body as string), etag: '"1"' }));
  };
  try {
    const client = new GoogleCalendarClient({ calendarId: 'test-calendar', clientEmail: 'test@example.com', privateKey: pem });
    const body = buildRosterEvent(await deriveSlotRosterEventId(TEST_SLOT), TEST_SLOT, [prospect]);
    await client.insertEvent(body);
    await client.replaceRoster(body, '"1"');
    assert.deepEqual(methods, ['POST', 'PATCH']);
  } finally { globalThis.fetch = original; }
});
