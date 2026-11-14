import { AccountStore } from './store.js';
import { OwnerGoogleError, type CalendarProvisioner } from './google-owner.js';
import { withLease } from '../llm-integration/runtime/persistence.js';

export async function provisionCalendar(db: D1Database, id: string, serviceAccountEmail: string, calendars: CalendarProvisioner) {
  if (!serviceAccountEmail || !serviceAccountEmail.includes('@')) throw new Error('Bot service account is not configured');
  return withLease(db, `provision:${id}`, async (lease) => {
    const store = new AccountStore(db), profile = await store.get(id);
    if (!profile || !profile.active) throw new Error('Active distribuidora required');
    if (profile.calendar_setup_status === 'ready') return profile;
    const save = async (status: string, calendarId = profile.google_calendar_id) => {
      await db.batch([lease.fence(), db.prepare('UPDATE distribuidoras SET calendar_setup_status=?,google_calendar_id=?,calendar_view_url=?,updated_at=? WHERE id=?')
        .bind(status, calendarId, calendarId ? `https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(btoa(calendarId))}` : null, new Date().toISOString(), id)]);
      profile.google_calendar_id = calendarId;
    };
    const marker = `DWC provisioning:${id}`;
    if (!profile.google_calendar_id) {
      if (['creating', 'creation_unknown'].includes(profile.calendar_setup_status)) {
        const existing = await calendars.find(marker);
        if (!existing) throw new Error('Calendar creation is unconfirmed; reconcile with the gym owner before retrying creation');
        await save('sharing', existing);
      } else {
        await save('creating');
        try { await save('sharing', await calendars.create(profile.name, marker)); }
        catch (error) {
          await save(error instanceof OwnerGoogleError && error.status >= 400 && error.status < 500 ? 'failed' : 'creation_unknown');
          throw new Error('Calendar setup needs retry or reconciliation');
        }
      }
    }
    await calendars.share(profile.google_calendar_id!, serviceAccountEmail, 'writer', false);
    await calendars.share(profile.google_calendar_id!, profile.email, 'reader', true);
    await save('ready');
    return (await store.get(id))!;
  });
}
