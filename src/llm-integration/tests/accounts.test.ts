import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountStore } from '../../accounts/store.js';
import { localD1 } from './fixtures.js';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

test('minimal profiles validate input and account routing never falls back to another distribuidora', async () => {
  const { db, dispose } = await localD1();
  try {
    const store = new AccountStore(db);
    assert.equal((await store.get('dwc'))?.name, 'Dallas Wellness Club');
    await assert.rejects(store.create({ name: 'A', email: 'bad' }));
    await assert.rejects(store.create({ name: 'A', email: 'a@example.com', tier: 'x' }));
    const a = await store.create({ name: 'Alicia', email: 'A@example.com' });
    const requestId = crypto.randomUUID();
    const first = await store.create({ name: 'Retry', email: 'retry@example.com' }, requestId);
    assert.equal((await store.create({ name: 'Retry', email: 'retry@example.com' }, requestId)).id, first.id);
    await assert.rejects(store.create({ name: 'Other', email: 'retry@example.com' }, requestId), /reused/);
    assert.equal(a.email, 'a@example.com');
    assert.equal(a.calendar_setup_status, 'pending');
    const identity = { channel: 'instagram' as const, businessAccountId: 'ig-a', senderId: 'customer' };
    assert.equal(await store.resolve(identity), null);
    await db.prepare("UPDATE distribuidoras SET google_calendar_id='cal-a',calendar_setup_status='ready' WHERE id=?").bind(a.id).run();
    await db.prepare(`INSERT INTO social_accounts (id,distribuidora_id,platform,provider_account_id,status,created_at,updated_at)
      VALUES ('a',?,'instagram','ig-a','connected','now','now')`).bind(a.id).run();
    assert.equal((await store.resolve(identity))?.distribuidora.id, a.id);
    assert.equal(await store.resolve({ ...identity, businessAccountId: 'unknown' }), null);
    await store.setActive(a.id, false);
    assert.equal(await store.resolve(identity), null);
    await store.setActive(a.id, true);
    await store.disconnect('a');
    assert.equal(await store.resolve(identity), null);
    assert.equal((await store.resolve(identity, true))?.account.id, 'a');
    const publicJson = JSON.stringify(await store.publicAccounts());
    assert.doesNotMatch(publicJson, /credential|encrypted/);
    await store.setSetting('reminder_sender_account_id', 'a');
    assert.equal(await store.setting('reminder_sender_account_id'), 'a');
  } finally { await dispose(); }
});

test('the additive foundation migration preserves existing booking calendar IDs and customer data', async () => {
  const { db, dispose } = await localD1('0006_booking_intake.sql');
  try {
    await db.prepare("INSERT INTO customers (id,name,language,created_at,updated_at) VALUES ('old-customer','Existing Customer','es','now','now')").run();
    await db.prepare(`INSERT INTO bookings (id,customer_id,starts_at,ends_at,status,calendar_id,created_at,updated_at)
      VALUES ('old-booking','old-customer','2026-12-01T12:00:00Z','2026-12-01T13:00:00Z','confirmed','existing-calendar','now','now')`).run();
    const sql = await readFile(new URL('../../../migrations/0007_distribuidoras.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').filter((part) => part.trim())) await db.prepare(statement).run();
    assert.deepEqual(await db.prepare("SELECT calendar_id,distribuidora_id FROM bookings WHERE id='old-booking'").first(), { calendar_id: 'existing-calendar', distribuidora_id: 'dwc' });
    assert.equal((await db.prepare("SELECT name FROM customers WHERE id='old-customer'").first<{ name: string }>())?.name, 'Existing Customer');
  } finally { await dispose(); }
});
