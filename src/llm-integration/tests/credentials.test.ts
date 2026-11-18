import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialVault } from '../../accounts/credentials.js';
import { localD1 } from './fixtures.js';

test('credential encryption survives rotation, rejects tampering and binds ciphertext to account ID', async () => {
  const { db, dispose } = await localD1();
  try {
    const keys = JSON.stringify({ first: btoa('a'.repeat(32)), second: btoa('b'.repeat(32)) });
    const vault = new CredentialVault(db, keys, 'first');
    await vault.put('account-a', { accessToken: 'private-access', refreshToken: 'private-refresh' });
    const row = await db.prepare('SELECT encrypted_payload FROM account_credentials WHERE id=?').bind('account-a').first<{ encrypted_payload: string }>();
    assert.ok(row);
    assert.doesNotMatch(row.encrypted_payload, /private-access|private-refresh/);
    await db.prepare('INSERT INTO account_credentials VALUES (?,?,?)').bind('account-b', row.encrypted_payload, 'now').run();
    await assert.rejects(vault.get('account-b'));
    const rotated = new CredentialVault(db, keys, 'second');
    assert.equal((await rotated.get('account-a'))?.accessToken, 'private-access');
    await rotated.rotate('account-a');
    assert.equal((await new CredentialVault(db, JSON.stringify({ second: btoa('b'.repeat(32)) }), 'second').get('account-a'))?.refreshToken, 'private-refresh');
    await assert.rejects(new CredentialVault(db, JSON.stringify({ first: btoa('c'.repeat(32)) }), 'first').get('account-b'));
  } finally { await dispose(); }
});
