import assert from 'node:assert/strict';
import test from 'node:test';
import { maintainConnections } from '../../accounts/maintenance.js';
import { AccountStore } from '../../accounts/store.js';
import { saveMessagingConnection } from '../../accounts/connections.js';
import { vaultFor } from '../../accounts/runtime.js';
import { localD1 } from './fixtures.js';
import type { Env } from '../../types/env.js';

test('token renewal isolates a revoked account while refreshing another account', async () => {
  const { db, dispose } = await localD1();
  try {
    const env: Env = { DB: db, META_APP_SECRET: '', META_VERIFY_TOKEN: '', ACCOUNT_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), ACCOUNT_CREDENTIAL_ACTIVE_KEY: 'v1' };
    const profile = await new AccountStore(db).create({ name: 'A', email: 'a@example.com' });
    const now = new Date().toISOString();
    for (const id of ['revoked', 'healthy']) await saveMessagingConnection(env, 'instagram', profile.id, { providerAccountId: id, handle: id,
      credentials: { accessToken: id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } });
    await db.prepare("UPDATE social_accounts SET updated_at='2020-01-01T00:00:00Z'").run();
    await maintainConnections(env, now, async (input) => new URL(String(input)).searchParams.get('access_token') === 'revoked'
      ? Response.json({ error: { code: 190 } }, { status: 400 }) : Response.json({ access_token: 'renewed', expires_in: 60 * 86_400 }));
    assert.equal((await db.prepare("SELECT status FROM social_accounts WHERE provider_account_id='revoked'").first<{ status: string }>())?.status, 'needs_authorization');
    assert.equal((await db.prepare("SELECT status FROM social_accounts WHERE provider_account_id='healthy'").first<{ status: string }>())?.status, 'connected');
    assert.equal((await vaultFor(env).get('social:instagram:healthy'))?.accessToken, 'renewed');
    assert.equal((await db.prepare("SELECT count(*) AS n FROM operational_alerts WHERE state='open'").first<{ n: number }>())?.n, 1);
  } finally { await dispose(); }
});
