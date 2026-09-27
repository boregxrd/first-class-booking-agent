import { GYM_TIME_ZONE, type Instant, type Language } from '../../model.js';
import { gymContext } from '../llm-integration/gym-context.js';
import { CalendarApiError, type GoogleCalendarEvent, type RosterCalendar, type RosterEventBody } from './client.js';

export interface ProspectSlotEntry {
  bookingId: string;
  name: string;
  phone: string | null;
  instagramHandle: string | null;
  language: Language;
}

/** Canonical UTC instant: equivalent local-offset timestamps map to exactly one event. */
export async function deriveSlotRosterEventId(startsAt: Instant): Promise<string> {
  const start = new Date(startsAt).toISOString();
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dwc_hourly_roster:${start}`));
  // Hex is a subset of Google's base32hex alphabet; scope is one dedicated calendar.
  return `d${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const line = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

export function buildRosterEvent(eventId: string, startsAt: Instant, prospects: ProspectSlotEntry[]): RosterEventBody {
  const start = new Date(startsAt).toISOString();
  const roster = [...new Map(prospects.map((person) => [person.bookingId, person])).values()]
    .sort((a, b) => a.bookingId.localeCompare(b.bookingId));
  const description = [
    'Dallas Wellness Club — free trial prospects',
    `Address: ${gymContext.address}`,
    `Duration: 1 hour | Time zone: ${GYM_TIME_ZONE}`,
    `Prospects (${roster.length}):`,
    ...roster.map((person) => [
      `- ${line(person.name)}`,
      person.phone ? `Phone: ${line(person.phone)}` : null,
      person.instagramHandle ? `Instagram: @${line(person.instagramHandle).replace(/^@/, '')}` : null,
      `Language: ${person.language}`,
      `Booking ID: ${person.bookingId}`,
    ].filter(Boolean).join(' | ')),
    '',
    'Roster maintained by the booking app. Change individual bookings through the app/chat.',
  ].join('\n');
  return {
    id: eventId, status: 'confirmed', summary: `DWC Free Trials — ${roster.length} prospects`,
    description, location: gymContext.address,
    start: { dateTime: start, timeZone: GYM_TIME_ZONE },
    end: { dateTime: new Date(Date.parse(start) + 60 * 60_000).toISOString(), timeZone: GYM_TIME_ZONE },
    extendedProperties: { private: { dwc_slot_start: start } },
  };
}

/**
 * Read Calendar BEFORE loading D1's latest desired roster. If another sync wins,
 * If-Match fails and we reload both. Never append text or match arbitrary events by time.
 * Keep empty roster events: deleting an event can tombstone its deterministic ID.
 */
export async function syncSlotRoster(
  calendar: RosterCalendar,
  startsAt: Instant,
  loadProspects: () => Promise<ProspectSlotEntry[]>,
): Promise<GoogleCalendarEvent> {
  const eventId = await deriveSlotRosterEventId(startsAt);
  const start = new Date(startsAt).toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await calendar.getEvent(eventId);
    if (existing && (existing.status !== 'confirmed' || !existing.etag
      || existing.extendedProperties?.private?.dwc_slot_start !== start
      || Date.parse(existing.start.dateTime) !== Date.parse(start)
      || Date.parse(existing.end.dateTime) !== Date.parse(start) + 60 * 60_000)) {
      throw new Error('Shared slot was modified externally; reconciliation is required');
    }
    const body = buildRosterEvent(eventId, start, await loadProspects());
    try {
      return existing ? await calendar.replaceRoster(body, existing.etag) : await calendar.insertEvent(body);
    } catch (error) {
      if (!(error instanceof CalendarApiError) || ![409, 412].includes(error.status)) throw error;
    }
  }
  throw new Error('Shared roster changed repeatedly; retry synchronization later');
}
