import { readFile, readdir } from 'node:fs/promises';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { CalendarApiError, type GoogleCalendarEvent, type RosterCalendar, type RosterEventBody } from '../../calendar/client.js';

export const TEST_NOW = '2026-09-27T12:00:00.000Z';
export const TEST_SLOT = '2026-09-28T13:00:00.000Z';

export async function localD1() {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test"); } }', d1Databases: ['DB'] });
  try {
    const db = await runtime.getD1Database('DB') as unknown as D1Database;
    const directory = new URL('../../../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      for (const statement of sql.replace(/--[^\n]*/g, '').split(';').filter((part) => part.trim())) await db.prepare(statement).run();
    }
    return { db, dispose: () => runtime.dispose() };
  } catch (error) { await runtime.dispose(); throw error; }
}

/** Realistic fake Google CAS semantics; no provider credentials/network calls. */
export class FakeRosterCalendar implements RosterCalendar {
  configuredCalendarId = 'dedicated-trials-calendar';
  events = new Map<string, GoogleCalendarEvent>();
  writes = 0;
  timeoutAfterWrite = false;
  failSlot: string | null = null;
  async getEvent(id: string) { return structuredClone(this.events.get(id) ?? null); }
  async insertEvent(body: RosterEventBody) {
    if (this.events.has(body.id)) throw new CalendarApiError(409);
    return this.write(body);
  }
  async replaceRoster(body: RosterEventBody, etag: string) {
    if (this.events.get(body.id)?.etag !== etag) throw new CalendarApiError(412);
    return this.write(body);
  }
  private write(body: RosterEventBody): GoogleCalendarEvent {
    if (body.start.dateTime === this.failSlot) throw new Error('simulated Calendar outage');
    const event = { ...structuredClone(body), etag: `"${++this.writes}"` };
    this.events.set(body.id, event);
    if (this.timeoutAfterWrite) { this.timeoutAfterWrite = false; throw new Error('timeout after Calendar accepted'); }
    return structuredClone(event);
  }
}

export async function seedCustomer(db: D1Database, id: string, phone: string | null = '+12145550101', handle: string | null = null) {
  await db.prepare('INSERT INTO customers (id, name, whatsapp_phone, instagram_handle, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, `Name ${id}`, phone, handle, 'es', TEST_NOW, TEST_NOW).run();
  if (phone) await db.prepare(
    `INSERT INTO consents (id, customer_id, phone, purpose, granted_at, source_channel, source_business_account_id, source_sender_id, source_message_id)
     VALUES (?, ?, ?, 'trial_confirmation_and_reminders', ?, 'instagram', 'gym', ?, 'confirmation')`
  ).bind(`consent-${id}`, id, phone, TEST_NOW, id).run();
}

export const bookingContext = (customerId: string, operationKey = 'book') => ({
  customerId, operationKey, conversationId: `conv-${customerId}`, sourceMessageId: 'confirmation', confirmationMessageId: 'confirmation', requestedAt: TEST_NOW,
});
