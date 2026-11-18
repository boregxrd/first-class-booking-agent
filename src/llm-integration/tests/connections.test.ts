import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerAuthorized } from '../../accounts/auth.js';
import { AccountStore } from '../../accounts/store.js';
import { startConnection, completeConnection, saveMessagingConnection } from '../../accounts/connections.js';
import { vaultFor } from '../../accounts/runtime.js';
import type { Env } from '../../types/env.js';
import { localD1 } from './fixtures.js';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { verifyOwnerAccess } from '../../accounts/auth.js';

test('owner API rejects cross-site writes, unsigned identities and short operator tokens', async () => {
  const env: Env = { META_APP_SECRET: '', META_VERIFY_TOKEN: '', ADMIN_ORIGIN: 'https://gym.example', ADMIN_API_TOKEN: 'a'.repeat(40) };
  const auth = { Authorization: `Bearer ${env.ADMIN_API_TOKEN}` };
  assert.equal(await ownerAuthorized(new Request('https://gym.example/admin', { headers: auth }), env), true);
  assert.equal(await ownerAuthorized(new Request('https://gym.example/admin', { method: 'POST', headers: { ...auth, Origin: 'https://evil.example' } }), env), false);
  assert.equal(await ownerAuthorized(new Request('https://gym.example/admin', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } }), env), false);
  assert.equal(await ownerAuthorized(new Request('https://gym.example/admin', { headers: { Authorization: 'Bearer short' } }), { ...env, ADMIN_API_TOKEN: 'short' }), false);
});

test('Google OAuth binds expiring one-use state, PKCE and exact gym identity', async () => {
  const { db, dispose } = await localD1();
  try {
    const env: Env = { DB: db, META_APP_SECRET: '', META_VERIFY_TOKEN: '', ADMIN_ORIGIN: 'https://gym.example',
      GOOGLE_OAUTH_CLIENT_ID: 'client', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', GOOGLE_OWNER_EMAIL: 'owner@example.com',
      ACCOUNT_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), ACCOUNT_CREDENTIAL_ACTIVE_KEY: 'v1' };
    const start = await startConnection(env, 'google', null), url = new URL(start.authorizationUrl), state = url.searchParams.get('state')!;
    assert.ok(url.searchParams.get('code_challenge'));
    assert.match(url.searchParams.get('scope')!, /gmail\.send/);
    assert.doesNotMatch(url.searchParams.get('scope')!, /gmail\.(?:readonly|modify|metadata)|https:\/\/mail\.google\.com/);
    let calls = 0;
    const provider: typeof fetch = async (input, options) => {
      calls++;
      if (String(input).includes('/token')) {
        assert.ok(String(options?.body).includes('code_verifier='));
        return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
          scope: ['calendar.calendars', 'calendar.calendarlist.readonly', 'calendar.acls', 'calendar.events'].map((scope) => `https://www.googleapis.com/auth/${scope}`).join(' ') });
      }
      return Response.json({ email: 'owner@example.com', email_verified: true, sub: 'owner' });
    };
    await completeConnection(env, 'google', state, 'code', provider);
    assert.equal((await vaultFor(env).get('google-owner'))?.email, 'owner@example.com');
    await assert.rejects(completeConnection(env, 'google', state, 'replay', provider));
    assert.equal(calls, 2);
    const other = new URL((await startConnection(env, 'google', null)).authorizationUrl).searchParams.get('state')!;
    await assert.rejects(completeConnection(env, 'google', other, 'code', async (input, options) => String(input).includes('/token')
      ? provider(input, options) : Response.json({ email: 'trainer@example.com', email_verified: true })), /Only the configured gym/);
    const profile = await new AccountStore(db).create({ name: 'A', email: 'a@example.com' });
    const account = { providerAccountId: '123', handle: 'a', credentials: { accessToken: 'access' } };
    await saveMessagingConnection(env, 'instagram', profile.id, account);
    await assert.rejects(saveMessagingConnection(env, 'instagram', 'dwc', account), /already belongs/);
  } finally { await dispose(); }
});

test('Instagram onboarding verifies the authorized account and its messaging subscription before connecting', async () => {
  const { db, dispose } = await localD1();
  try {
    const env: Env = { DB: db, META_APP_SECRET: '', META_VERIFY_TOKEN: '', ADMIN_ORIGIN: 'https://gym.example', META_GRAPH_API_VERSION: 'v26.0',
      INSTAGRAM_OAUTH_CLIENT_ID: 'client', INSTAGRAM_OAUTH_CLIENT_SECRET: 'secret',
      ACCOUNT_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), ACCOUNT_CREDENTIAL_ACTIVE_KEY: 'v1' };
    const store = new AccountStore(db), profile = await store.create({ name: 'A', email: 'a@example.com' });
    const state = new URL((await startConnection(env, 'instagram', profile.id)).authorizationUrl).searchParams.get('state')!;
    const calls: string[] = [];
    await completeConnection(env, 'instagram', state, 'code', async (input) => {
      const url = String(input); calls.push(url.split('?')[0]!);
      if (url.includes('api.instagram.com/oauth')) return Response.json({ access_token: 'short' });
      if (url.includes('/access_token')) return Response.json({ access_token: 'long', expires_in: 60 * 86_400 });
      if (url.includes('/me?')) return Response.json({ user_id: '12345', username: 'trainer.a' });
      assert.ok(url.endsWith('/12345/subscribed_apps'));
      return Response.json({ success: true });
    });
    const accounts = await store.publicAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.provider_account_id, '12345');
    assert.equal(accounts[0]?.status, 'connected');
    assert.doesNotMatch(JSON.stringify(accounts), /short|long|secret/);
    assert.equal(calls.length, 4);
    await assert.rejects(completeConnection(env, 'instagram', state, 'code'));
  } finally { await dispose(); }
});

test('Access sessions require a real signature, exact audience and allowed owner email', async () => {
  const original = globalThis.fetch;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'owner-key', alg: 'RS256', use: 'sig' };
  const env: Env = { META_APP_SECRET: '', META_VERIFY_TOKEN: '', ACCESS_TEAM_DOMAIN: 'owner-tests.cloudflareaccess.com', ACCESS_AUD: 'owner-audience', OWNER_EMAILS: 'owner@example.com' };
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://owner-tests.cloudflareaccess.com/cdn-cgi/access/certs');
      return Response.json({ keys: [key] });
    };
    const sign = (email: string, aud = 'owner-audience', expiry = '5m') => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'owner-key' })
      .setIssuer('https://owner-tests.cloudflareaccess.com').setAudience(aud).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
    assert.equal(await verifyOwnerAccess(await sign('owner@example.com'), env), true);
    assert.equal(await verifyOwnerAccess(await sign('trainer@example.com'), env), false);
    assert.equal(await verifyOwnerAccess(await sign('owner@example.com', 'different-app'), env), false);
    assert.equal(await verifyOwnerAccess(await sign('owner@example.com', 'owner-audience', '-1m'), env), false);
    assert.equal(await verifyOwnerAccess('unsigned.owner.jwt', env), false);
  } finally { globalThis.fetch = original; }
});
