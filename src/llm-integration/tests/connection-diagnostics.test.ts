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
import { alert } from '../runtime/persistence.js';

async function fixture() {
  const { db, dispose } = await localD1();
  const env: Env = { DB: db, META_APP_SECRET: '', META_VERIFY_TOKEN: '', ADMIN_ORIGIN: 'https://gym.example', META_GRAPH_API_VERSION: 'v26.0',
    INSTAGRAM_OAUTH_CLIENT_ID: 'instagram-client', INSTAGRAM_OAUTH_CLIENT_SECRET: 'private-app-secret',
    ACCOUNT_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), ACCOUNT_CREDENTIAL_ACTIVE_KEY: 'v1' };
  const profile = await new AccountStore(db).create({ name: 'Trainer', email: 'trainer@example.com' });
  const state = new URL((await startConnection(env, 'instagram', profile.id)).authorizationUrl).searchParams.get('state')!;
  return { db, env, profile, state, dispose };
}

const provider: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('api.instagram.com/oauth')) return Response.json({ data: [{ access_token: 'private-short-token' }] });
  if (url.includes('/access_token')) {
    assert.equal(typeof input, 'string', 'serialize the full Meta exchange URL explicitly');
    assert.equal(init?.method, 'GET');
    assert.equal(new URL(url).searchParams.get('grant_type'), 'ig_exchange_token');
    return Response.json({ access_token: 'private-long-token', expires_in: 3600 });
  }
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
    assert.doesNotMatch(row.detail, /private-app-secret|private-code/);
    assert.match(detail.providerSummary, /\[redacted\]/);
    const replay = await app.request(`/connections/callback/instagram?${new URLSearchParams({ state: f.state, code: 'private-code' })}`, {}, f.env);
    assert.match(await replay.text(), /expired or was already used/);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM operational_alerts WHERE kind='instagram_connection_failed'").first<{ n: number }>())?.n, 1);
  } finally { globalThis.fetch = original; await f.dispose(); }
});

test('failed long-token exchange retains an encrypted checkpoint and owner retry does not replay the OAuth code', async () => {
  const f = await fixture(), original = globalThis.fetch;
  try {
    f.env.ADMIN_API_TOKEN = 'x'.repeat(40);
    let shortCalls = 0, longCalls = 0;
    globalThis.fetch = async (input) => {
      if (String(input).includes('api.instagram.com/oauth')) { shortCalls++; return Response.json({ access_token: 'private-short-token', expires_in: 3600 }); }
      longCalls++;
      return Response.json({ error: { code: 100, message: 'Invalid access_token private-short-token https://example.com/?client_secret=private-app-secret private-code user@example.com AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }, { status: 400 });
    };
    const app = new Hono<{ Bindings: Env }>().route('/', createAccountRoutes());
    assert.equal((await app.request(`/connections/callback/instagram?${new URLSearchParams({ state: f.state, code: 'private-code' })}`, {}, f.env)).status, 400);
    const row = await f.db.prepare("SELECT resource_id,detail FROM operational_alerts WHERE kind='instagram_connection_failed'").first<{ resource_id: string; detail: string }>();
    assert.ok(row);
    const detail = JSON.parse(row.detail);
    assert.equal(detail.stage, 'long_token'); assert.equal(detail.shortTokenExpiresIn, 3600);
    assert.doesNotMatch(row.detail, /private-short-token|private-app-secret|private-code|user@example.com|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
    const checkpoint = await vaultFor(f.env).get(detail.checkpointId);
    assert.equal(checkpoint?.accessToken, 'private-short-token');
    assert.equal(checkpoint?.checkpoint?.kind, 'short');
    assert.equal(checkpoint?.checkpoint?.distribuidoraId, f.profile.id);
    assert.ok(Date.parse(checkpoint!.checkpoint!.resumeUntil) < Date.now() + 660_000);
    assert.equal((await new AccountStore(f.db).publicAccounts()).length, 0);
    assert.equal((await app.request('/admin/api/connections/retry-instagram', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: row.resource_id }) }, f.env)).status, 401);
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input).includes('api.instagram.com/oauth'), false, 'must not replay the original authorization code');
      if (String(input).includes('/access_token')) longCalls++;
      return provider(input, init);
    };
    const retry = await app.request('/admin/api/connections/retry-instagram', { method: 'POST', headers: { Authorization: `Bearer ${f.env.ADMIN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: row.resource_id }) }, f.env);
    assert.equal(retry.status, 200, await retry.text());
    assert.equal(shortCalls, 1); assert.equal(longCalls, 2);
    assert.equal((await new AccountStore(f.db).publicAccounts())[0]?.distribuidora_id, f.profile.id);
    assert.equal(await vaultFor(f.env).get(detail.checkpointId), null);
    const active = await vaultFor(f.env).get('social:instagram:12345');
    assert.equal(active?.checkpoint, undefined);
    assert.ok(Date.parse(active!.expiresAt!) > Date.now() + 3_500_000, 'the account keeps its real provider expiry, not the checkpoint retention deadline');
    assert.equal((await f.db.prepare('SELECT state FROM operational_alerts WHERE resource_id=?').bind(row.resource_id).first<{ state: string }>())?.state, 'resolved');
  } finally { globalThis.fetch = original; await f.dispose(); }
});

test('an expired checkpoint cannot resume the connection', async () => {
  const f = await fixture();
  try {
    let failure: ConnectionFailure | undefined;
    await assert.rejects(completeConnection(f.env, 'instagram', f.state, 'code', async (input) => String(input).includes('api.instagram.com/oauth')
      ? Response.json({ access_token: 'short-token' }) : Response.json({ error: { code: 100, message: 'Invalid token' } }, { status: 400 })), (error) => {
      assert.ok(error instanceof ConnectionFailure); failure = error; return true;
    });
    const reference = crypto.randomUUID(), checkpointId = failure!.checkpointId!;
    const value = (await vaultFor(f.env).get(checkpointId))!;
    await vaultFor(f.env).put(checkpointId, { ...value, checkpoint: { ...value.checkpoint!, resumeUntil: '2000-01-01T00:00:00.000Z' } });
    await f.db.prepare(`INSERT INTO operational_alerts (id,kind,resource_id,detail,created_at,updated_at) VALUES (?,'instagram_connection_failed',?,?,?,?)`)
      .bind(reference, reference, JSON.stringify({ distribuidoraId: f.profile.id, checkpointId }), 'now', 'now').run();
    const { retryInstagramConnection } = await import('../../accounts/connections.js');
    await assert.rejects(retryInstagramConnection(f.env, reference, async () => { throw new Error('must not call provider'); }), /checkpoint expired/);
  } finally { await f.dispose(); }
});

test('retry after an identity failure uses its long-token checkpoint without exchanging the short token again', async () => {
  const f = await fixture();
  try {
    let failure: ConnectionFailure | undefined;
    await assert.rejects(completeConnection(f.env, 'instagram', f.state, 'code', async (input, init) => String(input).includes('/me?')
      ? Response.json({ error: { code: 2, message: 'Temporary provider failure' } }, { status: 503 }) : provider(input, init)), (error) => {
      assert.ok(error instanceof ConnectionFailure); failure = error; return true;
    });
    const checkpointId = failure!.checkpointId!, stored = (await vaultFor(f.env).get(checkpointId))!;
    assert.equal(stored.checkpoint?.kind, 'long');
    const reference = crypto.randomUUID();
    await alert(f.db, 'instagram_connection_failed', reference, JSON.stringify({ distribuidoraId: f.profile.id, checkpointId }));
    const { retryInstagramConnection } = await import('../../accounts/connections.js');
    const result = await retryInstagramConnection(f.env, reference, async (input, init) => {
      assert.equal(String(input).includes('/access_token'), false);
      assert.equal(String(input).includes('api.instagram.com/oauth'), false);
      return provider(input, init);
    });
    assert.equal(result.accountId, 'instagram:12345');
    assert.equal(await vaultFor(f.env).get(checkpointId), null);
  } finally { await f.dispose(); }
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

test('reported missing Instagram permissions stop before exchange instead of producing a misleading later error', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await assert.rejects(completeConnection(f.env, 'instagram', f.state, 'code', async () => {
      calls++; return Response.json({ access_token: 'private-short-token', permissions: ['instagram_business_basic'] });
    }), (error) => {
      assert.ok(error instanceof ConnectionFailure);
      assert.equal(error.kind, 'permissions_missing'); assert.equal(error.stage, 'short_token');
      assert.deepEqual(error.details.grantedPermissions, ['instagram_business_basic']);
      assert.match(error.publicMessage(), /professional account type/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal((await new AccountStore(f.db).publicAccounts()).length, 0);
  } finally { await f.dispose(); }
});

test('permission diagnostics and read-only checkpoint inspection expose metadata, never token values or unknown scope strings', async () => {
  const f = await fixture();
  try {
    let failure: ConnectionFailure | undefined;
    await assert.rejects(completeConnection(f.env, 'instagram', f.state, 'code', async (input) => String(input).includes('api.instagram.com/oauth')
      ? Response.json({ access_token: 'IG-private-short-token', user_id: '12345', permissions: ['instagram_business_basic', 'instagram_business_manage_messages', 'private-unknown-scope-value'] })
      : Response.json({ error: { code: 100, message: 'Unsupported request - method type: get' } }, { status: 400 })), (error) => {
      assert.ok(error instanceof ConnectionFailure); failure = error; return true;
    });
    assert.deepEqual(failure!.details.grantedPermissions, ['instagram_business_basic', 'instagram_business_manage_messages']);
    assert.equal(failure!.details.category, 'unsupported_request');
    assert.match(failure!.publicMessage(), /unsupported API request/);
    assert.equal(failure!.details.unknownPermissionCount, 1); assert.equal(failure!.details.shortUserId, '12345');
    assert.doesNotMatch(JSON.stringify(failure!.details), /IG-private-short-token|private-unknown-scope-value/);
    const checkpointId = failure!.checkpointId!, before = (await vaultFor(f.env).get(checkpointId))!;
    const reference = crypto.randomUUID();
    await alert(f.db, 'instagram_connection_failed', reference, JSON.stringify({ distribuidoraId: f.profile.id, checkpointId }));
    const { retryInstagramConnection } = await import('../../accounts/connections.js');
    const inspection = await retryInstagramConnection(f.env, reference, async (input) => {
      assert.equal(new URL(String(input)).hostname, 'graph.instagram.com');
      return Response.json({ user_id: '12345', username: 'trainer.test' });
    }, true);
    assert.equal(inspection.checkpointInspection?.tokenFamily, 'instagram');
    assert.equal(inspection.checkpointInspection?.identityStatus, 200);
    assert.doesNotMatch(JSON.stringify(inspection), /IG-private-short-token|private-unknown-scope-value/);
    assert.equal((await vaultFor(f.env).get(checkpointId))?.checkpoint?.resumeUntil, before.checkpoint!.resumeUntil);
    assert.equal((await new AccountStore(f.db).publicAccounts()).length, 0);
  } finally { await f.dispose(); }
});

test('unsafe numeric provider IDs are never silently rounded into account mappings', async () => {
  const f = await fixture();
  try {
    await assert.rejects(completeConnection(f.env, 'instagram', f.state, 'code', async (input, init) => String(input).includes('/me?')
      ? Response.json({ user_id: Number.MAX_SAFE_INTEGER + 2, username: 'trainer.test' }) : provider(input, init)), (error) => {
      assert.ok(error instanceof ConnectionFailure);
      assert.equal(error.stage, 'account_identity'); assert.equal(error.kind, 'invalid_response');
      assert.equal(error.providerAccountId, undefined);
      return true;
    });
    assert.equal((await new AccountStore(f.db).publicAccounts()).length, 0);
  } finally { await f.dispose(); }
});
