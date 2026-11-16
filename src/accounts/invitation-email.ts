import { z } from 'zod';
import type { Env } from '../types/env.js';
import { AccountStore } from './store.js';
import { vaultFor } from './runtime.js';
import { callbackUrl, startConnection, stateHash } from './connections.js';
import { ownerGoogleToken } from './google-owner.js';
import { withLease } from '../llm-integration/runtime/persistence.js';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export class InvitationSetupError extends Error {}
type EmailState = 'sending' | 'accepted' | 'rejected' | 'unknown';
interface InvitationEmail {
  id: string; distribuidora_id: string; recipient: string; token_hash: string; secret_id: string;
  state: EmailState; provider_message_id: string | null; expires_at: string; opened_at: string | null;
}
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function invitationEmailAuthorized(env: Env): Promise<boolean> {
  try {
    const owner = await vaultFor(env).get('google-owner');
    return Boolean(env.GOOGLE_OWNER_EMAIL && owner?.email?.toLowerCase() === env.GOOGLE_OWNER_EMAIL.toLowerCase()
      && owner?.scopes?.includes(GMAIL_SEND_SCOPE));
  } catch { return false; }
}

/** Gmail acceptance is not mailbox delivery. Ambiguous sends are never blindly repeated. */
export async function emailInstagramInvitation(env: Env, profileId: string, requestId: string, request: typeof fetch = fetch) {
  if (!env.DB) throw new InvitationSetupError('Database is not configured');
  z.string().uuid().parse(requestId);
  if (!env.INSTAGRAM_OAUTH_CLIENT_ID || !env.INSTAGRAM_OAUTH_CLIENT_SECRET) throw new InvitationSetupError('Configure the Instagram OAuth application before emailing connection invitations.');
  if (!await invitationEmailAuthorized(env)) throw new InvitationSetupError('Reauthorize the gym Google account with Gmail send permission to email invitations. Inbox read access is not required.');
  const profile = await new AccountStore(env.DB).get(profileId);
  if (!profile?.active || profile.calendar_setup_status !== 'ready') throw new InvitationSetupError('Finish this active distribuidora’s calendar setup before emailing an invitation.');
  const recipient = z.string().email().parse(profile.email), from = z.string().email().parse(env.GOOGLE_OWNER_EMAIL);
  const origin = new URL(callbackUrl(env, 'instagram')).origin;
  return withLease(env.DB, `invitation-email:${requestId}`, async (lease) => {
    let row = await env.DB!.prepare('SELECT * FROM connection_invitation_emails WHERE id=?').bind(requestId).first<InvitationEmail>();
    if (row && (row.distribuidora_id !== profileId || row.recipient !== recipient)) throw new InvitationSetupError('Invitation request ID was reused for a different recipient.');
    const result = () => ({ invitationId: requestId, recipient, state: row!.state, expiresAt: row!.expires_at });
    if (row?.state === 'accepted' || row?.state === 'unknown') return result();
    if (row?.state === 'sending') {
      await env.DB!.batch([lease.fence(), env.DB!.prepare("UPDATE connection_invitation_emails SET state='unknown',updated_at=? WHERE id=?")
        .bind(new Date().toISOString(), requestId)]);
      row.state = 'unknown'; return result();
    }
    if (row && (row.opened_at || Date.parse(row.expires_at) <= Date.now())) throw new InvitationSetupError('This invitation was used or expired. Send a new invitation with a new request ID.');
    const accessToken = await ownerGoogleToken(env);
    const vault = vaultFor(env);
    let token: string;
    if (!row) {
      token = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const secretId = `invitation-email:${requestId}`, now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      await vault.put(secretId, { accessToken: token, expiresAt }, lease.fence);
      await env.DB!.batch([lease.fence(), env.DB!.prepare(`INSERT INTO connection_invitation_emails
        (id,distribuidora_id,recipient,token_hash,secret_id,state,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,'sending',?,?,?)`)
        .bind(requestId, profileId, recipient, await stateHash(token), secretId, expiresAt, now, now)]);
      row = (await env.DB!.prepare('SELECT * FROM connection_invitation_emails WHERE id=?').bind(requestId).first<InvitationEmail>())!;
    } else {
      const secret = await vault.get(row.secret_id);
      if (!secret) throw new InvitationSetupError('The invitation secret is unavailable; create a new invitation.');
      token = secret.accessToken;
      await env.DB!.batch([lease.fence(), env.DB!.prepare("UPDATE connection_invitation_emails SET state='sending',updated_at=? WHERE id=?")
        .bind(new Date().toISOString(), requestId)]);
    }
    const link = `${origin}/connect/instagram/${token}`;
    const body = `Hola ${profile.name},\n\nDallas Wellness Club te invita a conectar tu cuenta profesional de Instagram al asistente de reservas.\n\nAbre este enlace y pulsa Conectar Instagram:\n${link}\n\nEl enlace es personal, se puede usar una vez y vence en 24 horas. Al abrirlo se inicia una autorización de Instagram de 15 minutos.\n\nLa cuenta que autorices quedará vinculada a tu perfil y a tu calendario de Dallas Wellness Club. No necesitas acceso al portal de propietarios.\n\nDallas Wellness Club`;
    const encodedBody = btoa(String.fromCharCode(...new TextEncoder().encode(body))).match(/.{1,76}/g)!.join('\r\n');
    const mime = [`From: Dallas Wellness Club <${from}>`, `To: ${recipient}`, 'Subject: Connect your Instagram to Dallas Wellness Club', `Date: ${new Date().toUTCString()}`,
      `Message-ID: <dwc-instagram-${requestId}@${from.split('@')[1]}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64', '', encodedBody].join('\r\n');
    let state: EmailState = 'unknown', messageId: string | null = null;
    try {
      const response = await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: base64url(new TextEncoder().encode(mime)) }), signal: AbortSignal.timeout(20_000) });
      if (response.ok) {
        const data = await response.json() as { id?: unknown };
        if (typeof data.id === 'string' && data.id) { state = 'accepted'; messageId = data.id; }
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408) state = 'rejected';
    } catch { /* Network/response ambiguity stays unknown: Gmail might have accepted the email. */ }
    await env.DB!.batch([lease.fence(), env.DB!.prepare('UPDATE connection_invitation_emails SET state=?,provider_message_id=?,updated_at=? WHERE id=?')
      .bind(state, messageId, new Date().toISOString(), requestId)]);
    row.state = state;
    return result();
  });
}

/** GET is scanner-safe. Only a deliberate form POST consumes the emailed invitation. */
export async function inspectInvitation(env: Env, token: string) {
  if (!env.DB || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.DB.prepare(`SELECT e.id,e.distribuidora_id,d.name FROM connection_invitation_emails e JOIN distribuidoras d ON d.id=e.distribuidora_id
    WHERE e.token_hash=? AND e.expires_at>? AND e.opened_at IS NULL AND e.state IN ('accepted','unknown','sending') AND d.active=1 AND d.calendar_setup_status='ready'`)
    .bind(await stateHash(token), new Date().toISOString()).first<{ id: string; distribuidora_id: string; name: string }>();
}

export async function openInstagramInvitation(env: Env, token: string) {
  const invitation = await inspectInvitation(env, token);
  if (!invitation || !env.DB) throw new InvitationSetupError('Invitation expired, already used or unavailable. Ask the gym for a new email.');
  return withLease(env.DB, `invitation-open:${invitation.id}`, async (lease) => {
    if (!await inspectInvitation(env, token)) throw new InvitationSetupError('Invitation expired or already used.');
    const connection = await startConnection(env, 'instagram', invitation.distribuidora_id);
    await env.DB!.batch([lease.fence(), env.DB!.prepare('UPDATE connection_invitation_emails SET opened_at=?,updated_at=? WHERE id=? AND opened_at IS NULL')
      .bind(new Date().toISOString(), new Date().toISOString(), invitation.id)]);
    return connection.authorizationUrl;
  });
}
