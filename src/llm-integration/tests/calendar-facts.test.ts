import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarInputReference, calendarFacts, calendarReplyCorrection } from '../conversations/calendar-facts.js';
import { updateBookingIntake } from '../conversations/intake.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { gymContext } from '../gym-context.js';

const now = '2026-11-17T10:50:00.000Z', today = '2026-11-17';
const schedule = { timeZone: 'America/Chicago' as const, weekly: gymContext.advertisedSchedule,
  durationMinutes: 60, dateOverrides: [], minimumLeadMinutes: 0, bookingHorizonDays: 30 };

test('Tuesday 18 November 2026 is rejected as a weekday/date contradiction, not silently changed', () => {
  const intake = updateBookingIntake(undefined, 'confirmo el martes 18 de noviembre de 2026 a las 16:00', now, schedule);
  assert.equal(intake.date, null);
  assert.equal(intake.dateIssue?.kind, 'weekday_mismatch');
  assert.equal(intake.dateIssue?.date, '2026-11-18');
  assert.equal(intake.time, '16:00');
  assert.equal(updateBookingIntake(intake, 'sí', now, schedule).date, null);
  const corrected = updateBookingIntake(intake, 'el 18', now, schedule);
  assert.equal(corrected.date, '2026-11-18'); assert.equal(corrected.dateIssue, undefined);
});

test('Wednesday 18 November has the weekday class schedule and valid local slot', () => {
  const intake = updateBookingIntake(undefined, 'quiero el miércoles 18 de noviembre a las 4 pm', now, schedule);
  assert.equal(intake.date, '2026-11-18'); assert.equal(intake.dateIssue, undefined);
  const facts = calendarFacts(intake.date!, schedule);
  assert.equal(facts.weekdayEs, 'miércoles'); assert.equal(facts.weekdayEn, 'Wednesday');
  assert.equal(facts.hasClasses, true); assert.ok(facts.scheduledStartTimes.includes('16:00'));
});

test('today plus a conflicting explicit date is clarified using Dallas local date', () => {
  const input = calendarInputReference('hoy es martes 18 de noviembre de 2026', today);
  assert.equal(input?.issue?.kind, 'relative_mismatch');
  assert.equal(input?.issue?.expectedDate, today);
  assert.equal(calendarInputReference('Tuesday, November 18, 2026', today)?.issue?.kind, 'weekday_mismatch');
  assert.equal(calendarInputReference('martes 18 de noviembre de 2025', today)?.date, '2025-11-18');
});

test('bare weekday/day references are exact dates rather than a silently selected different week', () => {
  assert.equal(calendarInputReference('martes 18 a las 16:00', today)?.issue?.kind, 'weekday_mismatch');
  assert.equal(calendarInputReference('miércoles 18 a las 16:00', today)?.date, '2026-11-18');
  assert.equal(calendarInputReference('domingo 15', today)?.date, '2026-11-15');
  assert.equal(calendarInputReference('de lunes a viernes, 06:00 y 16:00', today), undefined);
  assert.equal(calendarInputReference('lunes 6 am', today), undefined);
});

test('reported model contradictions are caught, while a valid Sunday/Wednesday explanation is allowed', () => {
  const bad = 'El miércoles 18 de noviembre no tenemos clases; solo de lunes a viernes. Sin embargo, el 18 de noviembre de 2026 es martes.';
  assert.ok(calendarReplyCorrection(bad, today, schedule, '2026-11-18'));
  assert.ok(calendarReplyCorrection('El miércoles 18 de noviembre no tenemos clases.', today, schedule, '2026-11-18'));
  assert.equal(calendarReplyCorrection('Los domingos no tenemos clases, pero el miércoles 18 de noviembre sí tenemos clases.', today, schedule, '2026-11-18'), null);
});

test('prompt dates are computed in Dallas rather than copied from a UTC or phone-calendar day', () => {
  const prompt = buildSystemPrompt({ now: '2026-11-18T01:00:00Z', schedule });
  assert.match(prompt, /martes, 17 de noviembre de 2026 \(2026-11-17\)/);
  assert.match(prompt, /no reservas de clases regulares/);
  assert.match(prompt, /integration test/);
});
