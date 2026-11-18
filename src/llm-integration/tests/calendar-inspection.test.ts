import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleOwnerCalendars } from '../../accounts/google-owner.js';
import { vaultFor } from '../../accounts/runtime.js';
import type { Env } from '../../types/env.js';
import { localD1 } from './fixtures.js';

test('calendar inspection returns actual Google data ownership and sharing roles without exposing credentials', async () => {
  const { db, dispose } = await localD1(), original = globalThis.fetch;
  try {
    const env: Env = { DB: db, META_APP_SECRET: '', META_VERIFY_TOKEN: '', GOOGLE_OWNER_EMAIL: 'gym@example.com',
      ACCOUNT_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), ACCOUNT_CREDENTIAL_ACTIVE_KEY: 'v1' };
    await vaultFor(env).put('google-owner', { accessToken: 'private-owner-token', email: 'gym@example.com', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    globalThis.fetch = async (input, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-owner-token');
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://www.googleapis.com');
      if (url.pathname.endsWith('/acl')) return Response.json({ items: [
        { role: 'owner', scope: { type: 'user', value: 'gym@example.com' } },
        { role: 'writer', scope: { type: 'user', value: 'bot@example.com' } },
        { role: 'reader', scope: { type: 'user', value: 'trainer@example.com' } },
      ] });
      return Response.json({ id: 'trainer-calendar', summary: 'DWC — Trainer', dataOwner: 'gym@example.com', timeZone: 'America/Chicago' });
    };
    const result = await new GoogleOwnerCalendars(env).inspect('trainer-calendar');
    assert.equal(result.dataOwner, 'gym@example.com');
    assert.equal(result.publiclyShared, false);
    assert.deepEqual(result.access, [{ email: 'gym@example.com', role: 'owner' }, { email: 'bot@example.com', role: 'writer' }, { email: 'trainer@example.com', role: 'reader' }]);
    assert.doesNotMatch(JSON.stringify(result), /private-owner-token/);
  } finally { globalThis.fetch = original; await dispose(); }
});
