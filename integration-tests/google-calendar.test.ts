import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { GoogleCalendarClient } from '../src/calendar/client.js';
import { deriveSlotRosterEventId, syncSlotRoster, type ProspectSlotEntry } from '../src/calendar/slot-roster.js';

const enabled = process.env.GOOGLE_CALENDAR_INTEGRATION === '1';

test('Google Calendar creates and updates a shared test roster', { skip: !enabled }, async () => {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const startsAt = process.env.GOOGLE_CALENDAR_TEST_SLOT;
  assert.ok(calendarId, 'Set GOOGLE_CALENDAR_ID to a dedicated test calendar');
  assert.ok(clientEmail, 'Set GOOGLE_CLIENT_EMAIL');
  assert.ok(privateKey, 'Set GOOGLE_PRIVATE_KEY');
  assert.ok(startsAt, 'Set GOOGLE_CALENDAR_TEST_SLOT to an unused future ISO timestamp');

  const slotTime = Date.parse(startsAt);
  assert.ok(Number.isFinite(slotTime), 'GOOGLE_CALENDAR_TEST_SLOT must be a valid ISO timestamp');
  assert.ok(slotTime > Date.now(), 'GOOGLE_CALENDAR_TEST_SLOT must be in the future');

  const calendar = new GoogleCalendarClient({ calendarId, clientEmail, privateKey });
  const eventId = await deriveSlotRosterEventId(startsAt);
  assert.equal(
    await calendar.getEvent(eventId),
    null,
    'That deterministic slot already has an event. Choose another unused slot to avoid changing it.',
  );

  const prospects: ProspectSlotEntry[] = [
    { bookingId: 'manual-google-integration-1', name: 'Integration Test One', phone: null, instagramHandle: null, language: 'en' },
    { bookingId: 'manual-google-integration-2', name: 'Integration Test Two', phone: null, instagramHandle: null, language: 'en' },
  ];

  const created = await syncSlotRoster(calendar, startsAt, async () => [prospects[0]]);
  assert.equal(created.id, eventId);
  assert.match(created.summary, /1 prospects/);

  const updated = await syncSlotRoster(calendar, startsAt, async () => prospects);
  assert.equal(updated.id, eventId);
  assert.match(updated.summary, /2 prospects/);
  assert.match(updated.description ?? '', /Integration Test One/);
  assert.match(updated.description ?? '', /Integration Test Two/);

  const persisted = await calendar.getEvent(eventId);
  assert.ok(persisted, 'Expected the roster event to be readable from Google Calendar');
  assert.equal(persisted.status, 'confirmed');
  assert.equal(persisted.start.dateTime, new Date(slotTime).toISOString());
  assert.equal(Date.parse(persisted.end.dateTime) - Date.parse(persisted.start.dateTime), 60 * 60_000);
  assert.match(persisted.summary, /2 prospects/);
  assert.match(persisted.description ?? '', /Prospects \(2\)/);
  assert.match(persisted.description ?? '', /Integration Test One/);
  assert.match(persisted.description ?? '', /Integration Test Two/);

  console.log(`Google Calendar test event is ready to inspect: calendar=${calendarId}, event=${eventId}, start=${persisted.start.dateTime}`);
});
