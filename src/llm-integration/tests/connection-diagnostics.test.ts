import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { AccountStore } from '../../accounts/store.js';
import { startConnection, completeConnection, saveMessagingConnection } from '../../accounts/connections.js';
import { ConnectionFailure } from '../../accounts/connection-errors.js';
import { createAccountRoutes } from '../../accounts/routes.js';
import { vaultFor } from '../../accounts/runtime.js';
import type { Env } from '../../types/env.js';
import { localD1 } from './fixtures.js';

async function fixture() {
  const { db, dispose } = await localD1();
  const env: Env = { DB: db, META_APP_SECRET: '', META_VERIFY_TOKEN: '', ADMIN_ORIGIN: 'https://gym.example', META_GRAPH_API_VERSION: 'v26.0',
    INSTAGRAM_OAUTH_CLIENT_ID: 'instagram-client', INSTAGRAM_OAUTH_CLIENT_SECRET: 'private-app-secret',
    ACCOUNT_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), ACCOUNT_CREDENTIAL_ACTIVE_KEY: 'v1' };
  const profile = await new AccountStore(db).create({ name: 'Trainer', email: 'trainer@example.com' });
  const state = new URL((await startConnection(env, 'instagram', profile.id)).authorizationUrl).searchParams.get('state')!;
  return { db, env, profile, state, dispose };
}

const provider: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes('api.instagram.com/oauth')) return Response.json({ data: [{ access_token: 'private-short-token' }] });
  if (url.includes('/access_token')) return Response.json({ access_token: 'private-long-token', expires_in: 3600 });
  if (url.includes('/me?')) return Response.json({ user_id: '12345', username: 'trainer.test' });
  return Response.json({ success: true });
};

test('Instagram token exchange accepts a single-entry data response and binds the verified account', async () => {
  const f = await fixture();
  try {
    await completeConnection(f.env, 'instagram', f.state, 'authorization-code', provider);
    assert.equal((await new AccountStore(f.db).publicAccounts())[0]?.provider_account_id, '12345');
    assert.equal((await vaultFor(f.env).get('social:instagram:12345'))?.accessToken, 'private-long-token');
  } finally { await f.dispose(); }
});

test('callback failures expose a useful reference and persist only sanitized provider diagnostics', async () => {
  const f = await fixture(), original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: { message: 'Invalid client_secret private-app-secret; authorization-code=private-code', code: 100, error_subcode: 33 } }, { status: 400 });
    const app = new Hono<{ Bindings: Env }>().route('/', createAccountRoutes());
    const response = await app.request(`/connections/callback/instagram?${new URLSearchParams({ state: f.state, code: 'private-code' })}`, {}, f.env);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.match(text, /Instagram rejected the application credentials/);
    assert.match(text, /Reference: [a-f0-9-]{36}/);
    assert.doesNotMatch(text, /private-app-secret|private-code/);
    const row = await f.db.prepare("SELECT detail FROM operational_alerts WHERE kind='instagram_connection_failed'").first<{ detail: string }>();
    assert.ok(row);
    const detail = JSON.parse(row.detail);
    assert.equal(detail.stage, 'short_token'); assert.equal(detail.kind, 'provider_rejected');
    assert.equal(detail.httpStatus, 400); assert.equal(detail.providerCode, 100); assert.equal(detail.providerSubcode, 33);
    assert.equal(detail.category, 'client_credentials');
    assert.doesNotMatch(row.detail, /private-app-secret|private-code|Invalid client_secret/);
    const replay = await app.request(`/connections/callback/instagram?${new URLSearchParams({ state: f.state, code: 'private-code' })}`, {}, f.env);
    assert.match(await replay.text(), /expired or was already used/);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM operational_alerts WHERE kind='instagram_connection_failed'").first<{ n: number }>())?.n, 1);
  } finally { globalThis.fetch = original; await f.dispose(); }
});

test('an account already assigned to DWC yields an assignment error without moving it or replacing its credential', async () => {
  const f = await fixture();
  try {
    await saveMessagingConnection(f.env, 'instagram', 'dwc', { providerAccountId: '12345', handle: 'dwc', credentials: { accessToken: 'existing-dwc-token' } });
    await assert.rejects(completeConnection(f.env, 'instagram', f.state, 'authorization-code', provider), (error) => {
      assert.ok(error instanceof ConnectionFailure);
      assert.equal(error.stage, 'save_account'); assert.equal(error.kind, 'account_already_assigned');
      assert.equal(error.providerAccountId, '12345');
      assert.match(error.publicMessage(), /existing assignment was not changed/);
      return true;
    });
    assert.equal((await new AccountStore(f.db).publicAccounts())[0]?.distribuidora_id, 'dwc');
    assert.equal((await vaultFor(f.env).get('social:instagram:12345'))?.accessToken, 'existing-dwc-token');
  } finally { await f.dispose(); }
});
