import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountStore } from '../../accounts/store.js';
import { provisionCalendar } from '../../accounts/provisioning.js';
import type { CalendarProvisioner } from '../../accounts/google-owner.js';
import { localD1 } from './fixtures.js';

test('calendar creation, bot writer sharing and trainer reader invitation recover without duplicate calendars', async () => {
  const { db, dispose } = await localD1();
  try {
    const store = new AccountStore(db), profile = await store.create({ name: 'Alicia', email: 'alicia@example.com' });
    let created = 0, timeout = true;
    const calendars = new Map<string, string>(), shares: string[] = [];
    const provider: CalendarProvisioner = {
      create: async (_name, marker) => { created++; calendars.set(marker, 'alicia-calendar'); if (timeout) { timeout = false; throw new Error('response lost'); } return 'alicia-calendar'; },
      find: async (marker) => calendars.get(marker) ?? null,
      share: async (_id, email, role, notify) => { shares.push(`${email}:${role}:${notify}`); },
    };
    await assert.rejects(provisionCalendar(db, profile.id, 'bot@example.com', provider));
    assert.equal((await store.get(profile.id))?.calendar_setup_status, 'creation_unknown');
    const ready = await provisionCalendar(db, profile.id, 'bot@example.com', provider);
    assert.equal(ready.google_calendar_id, 'alicia-calendar');
    assert.equal(ready.calendar_setup_status, 'ready');
    assert.deepEqual(shares, ['bot@example.com:writer:false', 'alicia@example.com:reader:true']);
    await provisionCalendar(db, profile.id, 'bot@example.com', provider);
    assert.equal(created, 1); assert.equal(shares.length, 2);
  } finally { await dispose(); }
});

test('an ambiguous creation with no visible calendar never blindly creates another', async () => {
  const { db, dispose } = await localD1();
  try {
    const store = new AccountStore(db), profile = await store.create({ name: 'A', email: 'a@example.com' });
    await db.prepare("UPDATE distribuidoras SET calendar_setup_status='creating' WHERE id=?").bind(profile.id).run();
    const provider: CalendarProvisioner = { create: async () => { throw new Error('must not create'); }, find: async () => null, share: async () => {} };
    await assert.rejects(provisionCalendar(db, profile.id, 'bot@example.com', provider), /unconfirmed/);
    assert.equal((await store.get(profile.id))?.google_calendar_id, null);
  } finally { await dispose(); }
});
