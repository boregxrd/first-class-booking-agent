import assert from 'node:assert/strict';
import test from 'node:test';
import { dallasDate, dateHasClasses, isSelectedSlot, updateBookingIntake } from '../conversations/intake.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { gymContext } from '../gym-context.js';

const now = '2026-11-14T18:00:00Z'; // Saturday in Dallas; tomorrow is closed Sunday.
const schedule = { timeZone: 'America/Chicago' as const, weekly: gymContext.advertisedSchedule,
  durationMinutes: 60, dateOverrides: [], minimumLeadMinutes: 0, bookingHorizonDays: 30 };

test('6 am selects only an hour; a later explicit weekday selects the date', () => {
  const first = updateBookingIntake(undefined, 'quiero 6 am', now, schedule);
  assert.equal(first.time, '06:00');
  assert.equal(first.date, null);
  const second = updateBookingIntake(first, 'este lunes', now, schedule);
  assert.equal(second.date, '2026-11-16');
  assert.ok(isSelectedSlot(second, '2026-11-16T12:00:00Z'));
  assert.equal(isSelectedSlot(second, '2026-11-17T12:00:00Z'), false);
});

test('tomorrow keeps Sunday as selected rather than advancing to Monday', () => {
  const intake = updateBookingIntake(undefined, 'mañana a las 6 am', now, schedule);
  assert.equal(intake.date, '2026-11-15');
  assert.equal(dateHasClasses(intake.date!, schedule), false);
  assert.equal(dallasDate('2026-11-15T02:00:00Z'), '2026-11-14');
});

test('date forms, ambiguous hours, morning wording and conflicting day choices are handled conservatively', () => {
  for (const text of ['16/11/2026 a las 6 am', '16 de noviembre de 2026 a las 6 am', 'November 16, 2026 at 6 am', '2026-11-16 06:00']) {
    const intake = updateBookingIntake(undefined, text, now, schedule);
    assert.equal(intake.date, '2026-11-16', text);
    assert.equal(intake.time, '06:00', text);
  }
  assert.equal(updateBookingIntake(undefined, 'por la mañana a las 6 am', now, schedule).date, null);
  assert.equal(updateBookingIntake(undefined, 'quiero lunes o martes a las 6 am', now, schedule).date, null);
  assert.equal(updateBookingIntake(undefined, 'no el lunes', now, schedule).date, null);
  assert.equal(updateBookingIntake(undefined, 'lunes a las 7', now, schedule).time, null); // 7 am and 7 pm both exist.
  assert.equal(updateBookingIntake(undefined, 'lunes a las 7 pm', now, schedule).time, '19:00');
  assert.equal(updateBookingIntake(undefined, '31/11/2026 a las 6 am', now, schedule).date, null);
});

test('phone absence is explicit; a real international number supersedes absence', () => {
  const intake = updateBookingIntake(undefined, 'mi nombre es Alicia', now, schedule);
  assert.equal(intake.phoneUnavailable, false);
  const unavailable = updateBookingIntake(intake, 'No tengo teléfono', now, schedule);
  assert.equal(unavailable.phoneUnavailable, true);
  const supplied = updateBookingIntake(unavailable, 'Usa +34 600 000 000', now, schedule);
  assert.equal(supplied.phone, '+34600000000');
  assert.equal(supplied.phoneUnavailable, false);
});

test('welcome invites the free class without immediately asking morning or afternoon', () => {
  const prompt = buildSystemPrompt({ now, schedule });
  const greeting = prompt.split('Primer saludo:')[1]!.split('Pregunta sobre principiantes:')[0]!;
  assert.match(greeting, /¿Te gustaría probarla\?/);
  assert.doesNotMatch(greeting, /mañanas|tardes/);
  assert.match(prompt, /No ofrezcas cambiar el nombre/);
});
