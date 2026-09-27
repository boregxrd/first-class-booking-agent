import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveCalendarEventId, GoogleCalendarClient, GoogleCalendarEvent } from './client.js';
import { addProspectToSlotRoster, calculateOneHourEndTime } from './slot-roster.js';

test('deriveCalendarEventId generates valid, deterministic base32hex event IDs', async () => {
  const bookingId1 = 'booking_abc123';
  const id1 = await deriveCalendarEventId(bookingId1);
  const id2 = await deriveCalendarEventId(bookingId1);

  // Must be deterministic
  assert.equal(id1, id2);

  // Must be valid Google Calendar event ID (lowercase [a-v0-9], length >= 5)
  assert.match(id1, /^[a-v0-9]{5,1024}$/);
});

test('deriveCalendarEventId produces distinct IDs for distinct booking IDs', async () => {
  const idA = await deriveCalendarEventId('booking_1');
  const idB = await deriveCalendarEventId('booking_2');
  assert.notEqual(idA, idB);
});

test('calculateOneHourEndTime correctly adds 1 hour to start time', () => {
  const start = '2026-09-28T08:00:00.000Z';
  const end = calculateOneHourEndTime(start);
  assert.equal(end, '2026-09-28T09:00:00.000Z');
});

test('addProspectToSlotRoster creates new event if not existing, and appends if existing', async () => {
  const eventsDb = new Map<string, GoogleCalendarEvent>();

  // Generate valid test key
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;

  const pkcs8Buffer = (await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)) as ArrayBuffer;
  const binaryString = String.fromCharCode(...new Uint8Array(pkcs8Buffer));
  const base64Key = btoa(binaryString);
  const pemKey = `-----BEGIN PRIVATE KEY-----\n${base64Key}\n-----END PRIVATE KEY-----`;

  // Mock global fetch simulating a live Google Calendar store
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    const urlStr = url.toString();
    const method = init?.method || 'GET';

    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'fake_access_token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const eventIdMatch = urlStr.match(/\/events\/([^/?]+)/);
    const eventId = eventIdMatch ? decodeURIComponent(eventIdMatch[1]) : null;

    if (method === 'GET') {
      if (eventId && eventsDb.has(eventId)) {
        return new Response(JSON.stringify(eventsDb.get(eventId)), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (eventId) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(JSON.stringify({ items: Array.from(eventsDb.values()) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'POST' || method === 'PATCH') {
      const body = JSON.parse(init.body);
      const targetId = eventId || body.id || 'event_1';
      const existing = eventsDb.get(targetId);
      if (method === 'POST') {
        assert.equal(eventId, null, 'insertion uses the events collection endpoint');
        if (existing) return new Response('Conflict', { status: 409 });
      } else if (!existing) return new Response('Not Found', { status: 404 });

      const savedEvent: GoogleCalendarEvent = {
        id: targetId,
        etag: '"etag1"',
        status: 'confirmed',
        summary: body.summary ?? existing?.summary ?? '',
        description: body.description ?? existing?.description ?? '',
        start: body.start ?? existing?.start ?? { dateTime: '' },
        end: body.end ?? existing?.end ?? { dateTime: '' },
        updated: new Date().toISOString(),
      };
      eventsDb.set(targetId, savedEvent);
      return new Response(JSON.stringify(savedEvent), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Unsupported method', { status: 405 });
  };

  try {
    const client = new GoogleCalendarClient({
      calendarId: 'test_calendar@group.calendar.google.com',
      clientEmail: 'test-sa@project.iam.gserviceaccount.com',
      privateKey: pemKey,
    });

    const slotTime = '2026-09-28T08:00:00.000Z';

    // 1. Add first prospect -> should create new event with 1 hour duration
    const result1 = await addProspectToSlotRoster(client, {
      startsAt: slotTime,
      prospect: {
        firstName: 'Ana',
        phone: '+12145550101',
      },
    });

    assert.equal(result1.isNewEvent, true);
    assert.equal(result1.totalAttendees, 1);
    assert.match(result1.event.description || '', /Ana/);
    assert.match(result1.event.description || '', /\+12145550101/);
    assert.equal(result1.event.end.dateTime, '2026-09-28T09:00:00.000Z');

    // 2. Add second prospect to same slot -> should modify existing event description
    const result2 = await addProspectToSlotRoster(client, {
      startsAt: slotTime,
      prospect: {
        firstName: 'Sofía',
        instagramHandle: '@sofia.fit',
      },
    });

    assert.equal(result2.isNewEvent, false);
    assert.equal(result2.totalAttendees, 2);
    assert.match(result2.event.description || '', /Attendees \(2\):/);
    assert.match(result2.event.description || '', /Ana/);
    assert.match(result2.event.description || '', /Sofía/);
    assert.match(result2.event.description || '', /@sofia.fit/);

    const booking = { bookingId: 'retry-test', customerName: 'Test', startsAt: slotTime, endsAt: calculateOneHourEndTime(slotTime) };
    const inserted = await client.createTrialEvent(booking);
    const count = eventsDb.size;
    const replayed = await client.createTrialEvent(booking);
    assert.equal(replayed.id, inserted.id);
    assert.equal(eventsDb.size, count, 'a retry reconciles HTTP 409 instead of creating another event');
    await assert.rejects(client.createTrialEvent({ ...booking, startsAt: '2026-09-28T09:00:00Z' }), /409/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
