import type { RosterCalendar } from './client.js';
import { buildRosterEvent, syncSlotRoster } from './slot-roster.js';
import { loadSlotProspects } from '../bookings/roster.js';
import { alert, resolveAlert } from '../llm-integration/runtime/persistence.js';

/** Display-only policy: owner time/delete edits quarantine the WHOLE slot, never silently move customers. */
export async function inspectCalendarSlot(db: D1Database, calendar: RosterCalendar, startsAt: string, eventId: string, now: string): Promise<boolean> {
  let reason: string | null = null;
  try {
    const event = await calendar.getEvent(eventId);
    if (!event || event.status === 'cancelled') reason = 'owner_deleted_slot';
    else if (event.status !== 'confirmed' || event.extendedProperties?.private?.dwc_slot_start !== startsAt
      || Date.parse(event.start.dateTime) !== Date.parse(startsAt) || Date.parse(event.end.dateTime) !== Date.parse(startsAt) + 3600_000) reason = 'owner_changed_slot';
    else {
      const expected = buildRosterEvent(eventId, startsAt, await loadSlotProspects(db, calendar.configuredCalendarId, startsAt));
      if (event.description !== expected.description || event.summary !== expected.summary) {
        await syncSlotRoster(calendar, startsAt, () => loadSlotProspects(db, calendar.configuredCalendarId, startsAt));
      }
    }
  } catch { reason = 'calendar_unavailable'; }
  await db.prepare(`INSERT INTO calendar_slot_health (calendar_id, starts_at, event_id, state, reason, checked_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(calendar_id, starts_at) DO UPDATE SET event_id = excluded.event_id,
    state = excluded.state, reason = excluded.reason, checked_at = excluded.checked_at`)
    .bind(calendar.configuredCalendarId, startsAt, eventId, reason ? 'blocked' : 'healthy', reason, now).run();
  if (reason) await alert(db, 'calendar_slot_blocked', eventId, reason, now);
  else await resolveAlert(db, 'calendar_slot_blocked', eventId);
  return !reason;
}

export async function reconcileCalendarSlots(db: D1Database, calendar: RosterCalendar, now: string) {
  const slots = await db.prepare(`SELECT b.starts_at, b.event_id FROM bookings b
    LEFT JOIN calendar_slot_health h ON h.calendar_id = b.calendar_id AND h.starts_at = b.starts_at
    WHERE b.calendar_id = ? AND b.status IN ('pending','confirmed') AND b.ends_at > ? AND b.event_id IS NOT NULL
    GROUP BY b.starts_at, b.event_id ORDER BY min(COALESCE(h.checked_at, '')) LIMIT 5`)
    .bind(calendar.configuredCalendarId, now).all<{ starts_at: string; event_id: string }>();
  for (const slot of slots.results) await inspectCalendarSlot(db, calendar, slot.starts_at, slot.event_id, now);
}
