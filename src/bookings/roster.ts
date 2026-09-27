import type { ProspectSlotEntry } from '../calendar/slot-roster.js';

export async function loadSlotProspects(db: D1Database, calendarId: string, startsAt: string): Promise<ProspectSlotEntry[]> {
  const rows = await db.prepare(`SELECT b.id AS bookingId, c.name, c.whatsapp_phone AS phone, c.instagram_handle AS instagramHandle, c.language
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.calendar_id = ? AND b.starts_at = ? AND b.status IN ('pending', 'confirmed') ORDER BY b.id`)
    .bind(calendarId, startsAt).all<ProspectSlotEntry>();
  return rows.results;
}
