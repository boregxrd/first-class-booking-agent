import type { Env } from '../types/env.js';
import type { ChannelIdentity } from '../../model.js';
import { CredentialVault } from './credentials.js';
import { AccountStore, type AccountRoute } from './store.js';

export function vaultFor(env: Env) {
  if (!env.DB || !env.ACCOUNT_CREDENTIAL_KEYS || !env.ACCOUNT_CREDENTIAL_ACTIVE_KEY) throw new Error('Credential vault is not configured');
  return new CredentialVault(env.DB, env.ACCOUNT_CREDENTIAL_KEYS, env.ACCOUNT_CREDENTIAL_ACTIVE_KEY);
}

export async function routedEnvironment(env: Env, identity: ChannelIdentity): Promise<{ env: Env; route: AccountRoute } | null> {
  if (!env.DB) return null;
  const route = await new AccountStore(env.DB).resolve(identity);
  if (!route || !route.account.credential_id) return null;
  const credential = await vaultFor(env).get(route.account.credential_id);
  if (!credential || (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())) return null;
  return { route, env: { ...env, GOOGLE_CALENDAR_ID: route.distribuidora.google_calendar_id!,
    ...(identity.channel === 'instagram' ? { META_INSTAGRAM_ACCOUNT_ID: route.account.provider_account_id,
      META_INSTAGRAM_ACCESS_TOKEN: credential.accessToken, META_INSTAGRAM_TOKEN_EXPIRES_AT: credential.expiresAt }
      : { META_WHATSAPP_PHONE_NUMBER_ID: route.account.provider_account_id, META_WHATSAPP_ACCESS_TOKEN: credential.accessToken,
        META_WHATSAPP_TOKEN_EXPIRES_AT: credential.expiresAt }) } };
}

/** Owner-triggered, repeatable import. Never copies a legacy token into an arbitrary trainer account. */
export async function bootstrapLegacyAccounts(env: Env) {
  if (!env.DB || !env.GOOGLE_CALENDAR_ID) throw new Error('Legacy calendar is not configured');
  const store = new AccountStore(env.DB), vault = vaultFor(env), now = new Date().toISOString();
  const existing = await store.get('dwc');
  if (!existing || (existing.google_calendar_id && existing.google_calendar_id !== env.GOOGLE_CALENDAR_ID)) throw new Error('General calendar mapping conflicts');
  await env.DB.prepare("UPDATE distribuidoras SET google_calendar_id=?,calendar_view_url=?,calendar_setup_status='ready',updated_at=? WHERE id='dwc'")
    .bind(env.GOOGLE_CALENDAR_ID, `https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(btoa(env.GOOGLE_CALENDAR_ID))}`, now).run();
  for (const [platform, accountId, token, expiry] of [
    ['instagram', env.META_INSTAGRAM_ACCOUNT_ID, env.META_INSTAGRAM_ACCESS_TOKEN, env.META_INSTAGRAM_TOKEN_EXPIRES_AT],
    ['whatsapp', env.META_WHATSAPP_PHONE_NUMBER_ID, env.META_WHATSAPP_ACCESS_TOKEN, env.META_WHATSAPP_TOKEN_EXPIRES_AT],
  ] as const) {
    if (!accountId || !token) continue;
    const id = `legacy-${platform}`;
    const prior = await env.DB.prepare('SELECT id,distribuidora_id FROM social_accounts WHERE platform=? AND provider_account_id=?').bind(platform, accountId).first<{ id: string; distribuidora_id: string }>();
    if (prior) {
      if (prior.distribuidora_id !== 'dwc') throw new Error('Legacy account belongs to another profile');
      continue;
    }
    await vault.put(id, { accessToken: token, ...(expiry ? { expiresAt: expiry } : {}) });
    await env.DB.prepare(`INSERT INTO social_accounts (id,distribuidora_id,platform,provider_account_id,status,credential_id,token_expires_at,created_at,updated_at)
      VALUES (?,'dwc',?,?,'connected',?,?,?,?)`).bind(id, platform, accountId, id, expiry ?? null, now, now).run();
    if (platform === 'whatsapp' && !await store.setting('reminder_sender_account_id')) await store.setSetting('reminder_sender_account_id', id);
  }
  await store.setSetting('general_distribuidora_id', 'dwc');
}
