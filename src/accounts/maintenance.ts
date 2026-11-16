import type { Env } from '../types/env.js';
import { vaultFor } from './runtime.js';
import { withLease, alert, resolveAlert } from '../llm-integration/runtime/persistence.js';

/** Bounded renewal of supported Instagram tokens. Other providers supply their own refresh adapter. */
export async function maintainConnections(env: Env, now: string, request: typeof fetch = fetch) {
  if (!env.DB || !env.ACCOUNT_CREDENTIAL_KEYS || !env.ACCOUNT_CREDENTIAL_ACTIVE_KEY) return;
  await env.DB.prepare("UPDATE connection_invitation_emails SET state='unknown',updated_at=? WHERE state='sending' AND updated_at<?")
    .bind(now, new Date(Date.parse(now) - 600_000).toISOString()).run();
  const oldEmails = await env.DB.prepare('SELECT id,secret_id FROM connection_invitation_emails WHERE expires_at<? LIMIT 100')
    .bind(new Date(Date.parse(now) - 90 * 86_400_000).toISOString()).all<{ id: string; secret_id: string }>();
  if (oldEmails.results.length) await env.DB.batch(oldEmails.results.flatMap((row) => [
    env.DB!.prepare('DELETE FROM connection_invitation_emails WHERE id=?').bind(row.id),
    env.DB!.prepare('DELETE FROM account_credentials WHERE id=?').bind(row.secret_id),
  ]));
  await env.DB.prepare('DELETE FROM connection_states WHERE state_hash IN (SELECT state_hash FROM connection_states WHERE expires_at < ? LIMIT 100)')
    .bind(new Date(Date.parse(now) - 86_400_000).toISOString()).run();
  const rows = await env.DB.prepare(`SELECT id,credential_id,provider_account_id FROM social_accounts WHERE platform='instagram' AND status='connected'
    AND token_expires_at <= ? AND updated_at < ? ORDER BY token_expires_at LIMIT 5`)
    .bind(new Date(Date.parse(now) + 7 * 86_400_000).toISOString(), new Date(Date.parse(now) - 3_600_000).toISOString())
    .all<{ id: string; credential_id: string | null; provider_account_id: string }>();
  for (const row of rows.results) {
    try {
      await withLease(env.DB, `connect:instagram:${row.provider_account_id}`, async (lease) => {
        if (!row.credential_id) return;
        const vault = vaultFor(env), value = await vault.get(row.credential_id);
        if (!value) throw new Error('Missing account credential');
        const url = new URL('https://graph.instagram.com/refresh_access_token');
        url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: value.accessToken }).toString();
        const response = await request(url, { signal: AbortSignal.timeout(15_000) });
        const data = await response.json() as { access_token?: string; expires_in?: number; error?: { code?: number } };
        if (!response.ok || typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || data.expires_in <= 0) {
          if (data.error?.code === 190) await env.DB!.prepare("UPDATE social_accounts SET status='needs_authorization' WHERE id=?").bind(row.id).run();
          throw new Error('Account renewal requires retry or authorization');
        }
        const expiresAt = new Date(Date.parse(now) + data.expires_in * 1000).toISOString();
        await vault.put(row.credential_id, { ...value, accessToken: data.access_token, expiresAt }, lease.fence);
        await env.DB!.batch([lease.fence(), env.DB!.prepare('UPDATE social_accounts SET token_expires_at=?,updated_at=? WHERE id=?').bind(expiresAt, now, row.id)]);
        await resolveAlert(env.DB!, 'account_refresh_failed', row.id);
      });
    } catch {
      await env.DB.prepare('UPDATE social_accounts SET updated_at=? WHERE id=?').bind(now, row.id).run();
      await alert(env.DB, 'account_refresh_failed', row.id, 'Reconnect this account if authorization expired; other accounts remain independent', now);
    }
  }
}
