import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { AccountStore } from '../../accounts/store.js';
import { vaultFor } from '../../accounts/runtime.js';
import { createAccountRoutes } from '../../accounts/routes.js';
import { emailInstagramInvitation, GMAIL_SEND_SCOPE } from '../../accounts/invitation-email.js';
import type { Env } from '../../types/env.js';
import { localD1 } from './fixtures.js';

async function fixture() {
  const { db, dispose } = await localD1();
  const env: Env = { DB: db, META_APP_SECRET: '', META_VERIFY_TOKEN: '', ADMIN_ORIGIN: 'https://gym.example', GOOGLE_OWNER_EMAIL: 'gym@example.com',
    INSTAGRAM_OAUTH_CLIENT_ID: 'instagram-client', INSTAGRAM_OAUTH_CLIENT_SECRET: 'instagram-secret',
    ACCOUNT_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), ACCOUNT_CREDENTIAL_ACTIVE_KEY: 'v1' };
  const profile = await new AccountStore(db).create({ name: 'Alicia <script>', email: 'alicia@example.com' });
  await db.prepare("UPDATE distribuidoras SET google_calendar_id='alicia-calendar',calendar_setup_status='ready' WHERE id=?").bind(profile.id).run();
  await vaultFor(env).put('google-owner', { accessToken: 'private-gym-token', email: 'gym@example.com', scopes: [GMAIL_SEND_SCOPE], expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  return { db, dispose, env, profile };
}

function emailBody(init?: RequestInit): { mime: string; body: string } {
  const { raw } = JSON.parse(String(init?.body));
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  return { mime, body: Buffer.from(mime.split('\r\n\r\n')[1]!.replace(/\s/g, ''), 'base64').toString('utf8') };
}

test('gym Gmail emails a private 24-hour invitation exactly once per request, without returning its secret', async () => {
  const f = await fixture();
  try {
    let calls = 0, link = '';
    const request: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-gym-token');
      const email = emailBody(init);
      assert.match(email.mime, /From: Dallas Wellness Club <gym@example.com>/);
      assert.match(email.mime, /To: alicia@example.com/);
      assert.doesNotMatch(email.mime, /\r\n(?:Cc|Bcc):/);
      assert.match(email.body, /24 horas/);
      link = email.body.match(/https:\/\/gym\.example\/connect\/instagram\/[A-Za-z0-9_-]+/)![0];
      assert.ok(email.mime.split('\r\n').every((line) => line.length < 998));
      return Response.json({ id: 'gmail-message-1' });
    };
    const id = crypto.randomUUID();
    const result = await emailInstagramInvitation(f.env, f.profile.id, id, request);
    assert.equal(result.state, 'accepted'); assert.equal(result.recipient, 'alicia@example.com');
    assert.ok(Date.parse(result.expiresAt) > Date.now() + 23 * 3_600_000);
    assert.deepEqual(await emailInstagramInvitation(f.env, f.profile.id, id, request), result);
    assert.equal(calls, 1);
    const token = new URL(link).pathname.split('/').at(-1)!;
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    const stored = await f.db.prepare('SELECT * FROM connection_invitation_emails').first();
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(token));
    const secret = await f.db.prepare('SELECT encrypted_payload FROM account_credentials WHERE id=?').bind(`invitation-email:${id}`).first();
    assert.doesNotMatch(JSON.stringify(secret), new RegExp(token));
    const app = new Hono<{ Bindings: Env }>().route('/', createAccountRoutes());
    const pathname = new URL(link).pathname;
    for (let scanner = 0; scanner < 2; scanner++) {
      const page = await app.request(pathname, {}, f.env);
      assert.equal(page.status, 200);
      const body = await page.text();
      assert.match(body, /Alicia &lt;script&gt;/);
      assert.doesNotMatch(body, /<script>/);
    }
    assert.equal((await f.db.prepare('SELECT opened_at FROM connection_invitation_emails').first<{ opened_at: string | null }>())?.opened_at, null);
    const proceed = await app.request(pathname, { method: 'POST' }, f.env);
    assert.equal(proceed.status, 303);
    const authorization = new URL(proceed.headers.get('Location')!);
    assert.equal(authorization.origin, 'https://www.instagram.com');
    assert.equal(authorization.pathname, '/oauth/authorize');
    assert.ok(authorization.searchParams.get('state'));
    assert.equal((await app.request(pathname, { method: 'POST' }, f.env)).status, 410);
    assert.equal((await app.request(pathname, {}, f.env)).status, 410);
    assert.equal((await app.request('/admin/api/overview', {}, f.env)).status, 401, 'an email invitation never grants owner portal access');
  } finally { await f.dispose(); }
});

test('network ambiguity is recorded and never blindly resends an email', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const request: typeof fetch = async () => { calls++; throw new Error('Gmail might have accepted before timeout'); };
    const id = crypto.randomUUID();
    assert.equal((await emailInstagramInvitation(f.env, f.profile.id, id, request)).state, 'unknown');
    assert.equal((await emailInstagramInvitation(f.env, f.profile.id, id, request)).state, 'unknown');
    assert.equal(calls, 1);
  } finally { await f.dispose(); }
});

test('explicit Gmail rejection can be retried with the same invitation; expired links stay unusable', async () => {
  const f = await fixture();
  try {
    const bodies: string[] = [], id = crypto.randomUUID();
    const first = await emailInstagramInvitation(f.env, f.profile.id, id, async (_url, init) => {
      bodies.push(emailBody(init).body); return new Response('', { status: 403 });
    });
    assert.equal(first.state, 'rejected');
    const second = await emailInstagramInvitation(f.env, f.profile.id, id, async (_url, init) => {
      bodies.push(emailBody(init).body); return Response.json({ id: 'accepted-after-enabling-gmail-api' });
    });
    assert.equal(second.state, 'accepted'); assert.deepEqual(bodies[0], bodies[1]);
    const link = bodies[1]!.match(/https:\/\/gym\.example\/connect\/instagram\/[A-Za-z0-9_-]+/)![0];
    await f.db.prepare("UPDATE connection_invitation_emails SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").bind(id).run();
    const app = new Hono<{ Bindings: Env }>().route('/', createAccountRoutes());
    assert.equal((await app.request(new URL(link).pathname, {}, f.env)).status, 410);
  } finally { await f.dispose(); }
});

test('missing send permission and missing Meta configuration fail before sending or creating invitations', async () => {
  const f = await fixture();
  try {
    const request: typeof fetch = async () => { throw new Error('must not call Gmail'); };
    await assert.rejects(emailInstagramInvitation({ ...f.env, INSTAGRAM_OAUTH_CLIENT_ID: undefined }, f.profile.id, crypto.randomUUID(), request), /Configure the Instagram/);
    const credentials = (await vaultFor(f.env).get('google-owner'))!;
    await vaultFor(f.env).put('google-owner', { ...credentials, scopes: [] });
    await assert.rejects(emailInstagramInvitation(f.env, f.profile.id, crypto.randomUUID(), request), /Gmail send permission/);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM connection_invitation_emails').first<{ n: number }>())?.n, 0);
  } finally { await f.dispose(); }
});
