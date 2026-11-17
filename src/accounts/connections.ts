import { z } from 'zod';
import type { Env } from '../types/env.js';
import { AccountStore, type Platform } from './store.js';
import { vaultFor } from './runtime.js';
import { withLease, resolveAlert } from '../llm-integration/runtime/persistence.js';
import type { CredentialPayload } from './credentials.js';
import { AccountAssignmentError, ConnectionFailure, providerFailure, type ConnectionStage } from './connection-errors.js';

export interface ConnectedProviderAccount { providerAccountId: string; handle: string | null; credentials: CredentialPayload }
/** Extension boundary for Félix: login alone must not be reported as messaging access. */
export interface MessagingConnectionAdapter {
  platform: Platform;
  exchangeAndVerify(code: string, redirectUri: string): Promise<ConnectedProviderAccount>;
}
const bytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));
const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const instagramId = z.union([z.string().regex(/^\d{1,64}$/), z.number().int().safe().nonnegative().transform(String)]);
const requiredInstagramPermissions = ['instagram_business_basic', 'instagram_business_manage_messages'];
const knownInstagramPermissions = new Set([...requiredInstagramPermissions, 'instagram_business_manage_comments', 'instagram_business_content_publish',
  'instagram_business_manage_insights', 'instagram_basic', 'instagram_manage_messages', 'user_profile', 'user_media']);
export async function stateHash(value: string) { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
export function callbackUrl(env: Env, provider: 'google' | 'instagram') {
  const origin = new URL(env.ADMIN_ORIGIN ?? '');
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Canonical HTTPS ADMIN_ORIGIN required');
  return `${origin.origin}/connections/callback/${provider}`;
}
async function json(response: Response, stage?: ConnectionStage, sensitiveValues: readonly string[] = []): Promise<any> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (stage) throw providerFailure(stage, response.status, body, sensitiveValues);
    throw new Error(`Provider authorization failed (${response.status})`);
  }
  if (body === null && stage) throw new ConnectionFailure(stage, 'invalid_response');
  return body;
}

export async function startConnection(env: Env, provider: 'google' | 'instagram', distribuidoraId: string | null) {
  if (!env.DB) throw new Error('Database required');
  vaultFor(env); // Fail before asking a person to authorize if tokens cannot be stored safely.
  const redirectUri = callbackUrl(env, provider), state = base64url(bytes(32)), verifier = base64url(bytes(48));
  const clientId = provider === 'google' ? env.GOOGLE_OAUTH_CLIENT_ID : env.INSTAGRAM_OAUTH_CLIENT_ID;
  if (!clientId || (provider === 'google' ? !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OWNER_EMAIL : !env.INSTAGRAM_OAUTH_CLIENT_SECRET)) throw new Error('Provider OAuth is not configured');
  if (provider === 'instagram' && (!distribuidoraId || !(await new AccountStore(env.DB).get(distribuidoraId))?.active)) throw new Error('Active distribuidora required');
  const url = new URL(provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://www.instagram.com/oauth/authorize');
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state,
    scope: provider === 'google' ? 'openid email https://www.googleapis.com/auth/calendar.calendars https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.acls https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send'
      : 'instagram_business_basic,instagram_business_manage_messages' }).toString();
  if (provider === 'google') {
    url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('login_hint', env.GOOGLE_OWNER_EMAIL!);
    url.searchParams.set('code_challenge', await stateHash(verifier)); url.searchParams.set('code_challenge_method', 'S256');
  } else { url.searchParams.set('enable_fb_login', '0'); url.searchParams.set('force_authentication', '1'); }
  await env.DB.prepare('INSERT INTO connection_states (state_hash,provider,distribuidora_id,verifier,expires_at) VALUES (?,?,?,?,?)')
    .bind(await stateHash(state), provider, distribuidoraId, verifier, new Date(Date.now() + 15 * 60_000).toISOString()).run();
  return { authorizationUrl: url.toString(), expiresInSeconds: 900 };
}

export async function saveMessagingConnection(env: Env, platform: Platform, distribuidoraId: string, account: ConnectedProviderAccount) {
  if (!env.DB) throw new Error('Database required');
  return withLease(env.DB, `connect:${platform}:${account.providerAccountId}`, async (lease) => {
    if (!(await new AccountStore(env.DB!).get(distribuidoraId))?.active) throw new Error('Active distribuidora required');
    const previous = await env.DB!.prepare('SELECT id,distribuidora_id FROM social_accounts WHERE platform=? AND provider_account_id=?')
      .bind(platform, account.providerAccountId).first<{ id: string; distribuidora_id: string }>();
    if (previous && previous.distribuidora_id !== distribuidoraId) throw new AccountAssignmentError();
    const id = previous?.id ?? `${platform}:${account.providerAccountId}`, credentialId = `social:${id}`, now = new Date().toISOString();
    await vaultFor(env).put(credentialId, account.credentials, lease.fence);
    await env.DB!.batch([lease.fence(), env.DB!.prepare(`INSERT INTO social_accounts (id,distribuidora_id,platform,provider_account_id,handle,status,credential_id,token_expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'connected',?,?,?,?) ON CONFLICT(platform,provider_account_id) DO UPDATE SET
      handle=excluded.handle,status='connected',credential_id=excluded.credential_id,token_expires_at=excluded.token_expires_at,updated_at=excluded.updated_at`)
      .bind(id, distribuidoraId, platform, account.providerAccountId, account.handle, credentialId, account.credentials.expiresAt ?? null, now, now)]);
    return id;
  });
}

export async function completeConnection(env: Env, provider: 'google' | 'instagram', state: string, code: string, request: typeof fetch = fetch) {
  if (!env.DB || state.length > 128 || !code || code.length > 4096) throw provider === 'instagram'
    ? new ConnectionFailure('callback', 'invalid_callback') : new Error('Invalid authorization callback');
  const row = await env.DB.prepare(`UPDATE connection_states SET used_at=? WHERE state_hash=? AND provider=? AND used_at IS NULL AND expires_at>?
    RETURNING distribuidora_id,verifier`).bind(new Date().toISOString(), await stateHash(state), provider, new Date().toISOString())
    .first<{ distribuidora_id: string | null; verifier: string }>();
  if (!row) throw provider === 'instagram' ? new ConnectionFailure('state', 'state_expired_or_used') : new Error('Authorization link expired or was already used');
  const redirectUri = callbackUrl(env, provider);
  if (provider === 'google') {
    const token = await json(await request('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: row.verifier,
        client_id: env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET! }) }));
    const validated = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive(), scope: z.string() }).parse(token);
    for (const required of ['calendar.calendars', 'calendar.calendarlist.readonly', 'calendar.acls', 'calendar.events']) {
      if (!validated.scope.split(' ').includes(`https://www.googleapis.com/auth/${required}`)) throw new Error('Required calendar permission was not granted');
    }
    const user = await json(await request('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${validated.access_token}` }, signal: AbortSignal.timeout(15_000) }));
    if (user.email_verified !== true || typeof user.email !== 'string' || !env.GOOGLE_OWNER_EMAIL || user.email.toLowerCase() !== env.GOOGLE_OWNER_EMAIL.toLowerCase()) throw new Error('Only the configured gym Google account may authorize calendars');
    await withLease(env.DB, 'google-owner-token', async (lease) => {
      const prior = await vaultFor(env).get('google-owner');
      const refreshToken = validated.refresh_token ?? (prior && prior.email === user.email ? prior.refreshToken : undefined);
      if (!refreshToken) throw new Error('Offline Google consent is required');
      await vaultFor(env).put('google-owner', { accessToken: validated.access_token, refreshToken,
        expiresAt: new Date(Date.now() + validated.expires_in * 1000).toISOString(), email: user.email, subject: user.sub,
        scopes: validated.scope.split(' ') }, lease.fence);
    });
    return;
  }
  if (!row.distribuidora_id) throw new Error('Missing distribuidora');
  let shortToken: string, shortTokenExpiresIn: number | undefined;
  const metadata: { grantedPermissions?: string[]; unknownPermissionCount?: number; shortUserId?: string; shortUserIdUnsafeNumber?: boolean } = {};
  try {
    const short = await json(await request('https://api.instagram.com/oauth/access_token', { method: 'POST', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: env.INSTAGRAM_OAUTH_CLIENT_ID!, client_secret: env.INSTAGRAM_OAUTH_CLIENT_SECRET! }) }), 'short_token', [env.INSTAGRAM_OAUTH_CLIENT_SECRET!, code, state]);
    const shortSchema = z.object({ access_token: z.string().min(1), expires_in: z.unknown().optional(), user_id: z.unknown().optional(),
      permissions: z.union([z.string(), z.array(z.string())]).optional() });
    const value = z.union([shortSchema, z.object({ data: z.array(shortSchema).length(1) }).transform((data) => data.data[0]!)]).parse(short);
    shortToken = value.access_token;
    const ttl = Number(value.expires_in);
    if (Number.isFinite(ttl) && ttl > 0) shortTokenExpiresIn = ttl;
    const userId = instagramId.safeParse(value.user_id);
    if (userId.success) metadata.shortUserId = userId.data; // Diagnostic only; binding still requires a verified Graph identity.
    if (typeof value.user_id === 'number' && !Number.isSafeInteger(value.user_id)) metadata.shortUserIdUnsafeNumber = true;
    if (value.permissions !== undefined) {
      const permissions = typeof value.permissions === 'string' ? value.permissions.split(/[\s,]+/).filter(Boolean) : value.permissions;
      metadata.grantedPermissions = [...new Set(permissions.filter((permission) => knownInstagramPermissions.has(permission)))];
      metadata.unknownPermissionCount = permissions.filter((permission) => !knownInstagramPermissions.has(permission)).length;
      if (requiredInstagramPermissions.some((permission) => !metadata.grantedPermissions!.includes(permission))) {
        throw new ConnectionFailure('short_token', 'permissions_missing', metadata);
      }
    }
  } catch (error) {
    const failure = error instanceof ConnectionFailure ? error : new ConnectionFailure('short_token', error instanceof z.ZodError ? 'invalid_response' : 'network_or_internal');
    failure.validatedState = true; failure.distribuidoraId = row.distribuidora_id; throw failure;
  }
  try {
    return await finishInstagramToken(env, row.distribuidora_id, { kind: 'short', accessToken: shortToken,
      ...(metadata.grantedPermissions ? { grantedPermissions: metadata.grantedPermissions } : {}),
      ...(shortTokenExpiresIn ? { expiresAt: new Date(Date.now() + shortTokenExpiresIn * 1000).toISOString() } : {}) }, request, [code, state]);
  } catch (error) {
    if (error instanceof ConnectionFailure) {
      Object.assign(error.details, metadata);
      if (shortTokenExpiresIn) error.details.shortTokenExpiresIn = shortTokenExpiresIn;
    }
    throw error;
  }
}

async function finishInstagramToken(env: Env, profileId: string, input: { kind: 'short' | 'long'; accessToken: string; expiresAt?: string; resumeUntil?: string; grantedPermissions?: string[] },
  request: typeof fetch, extraSecrets: readonly string[] = []) {
  let stage: ConnectionStage = input.kind === 'short' ? 'long_token' : 'account_identity';
  let providerAccountId: string | undefined;
  let token = input;
  const secrets = [env.INSTAGRAM_OAUTH_CLIENT_SECRET!, input.accessToken, ...extraSecrets];
  try {
    if (token.kind === 'short') {
      stage = 'long_token';
      const exchange = new URL('https://graph.instagram.com/access_token');
      exchange.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: env.INSTAGRAM_OAUTH_CLIENT_SECRET!, access_token: token.accessToken }).toString();
      const long = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() })
        .parse(await json(await request(exchange.toString(), { method: 'GET', signal: AbortSignal.timeout(15_000) }), stage, secrets));
      token = { ...token, kind: 'long', accessToken: long.access_token, expiresAt: new Date(Date.now() + long.expires_in * 1000).toISOString() };
      secrets.push(token.accessToken);
    }
    const version = env.META_GRAPH_API_VERSION;
    if (!/^v\d+\.\d+$/.test(version ?? '')) throw new Error('Meta API version required');
    stage = 'account_identity';
    const user = await json(await request(`https://graph.instagram.com/${version}/me?fields=user_id,username`, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(15_000) }), stage, secrets);
    const providerId = instagramId.parse(user.user_id);
    providerAccountId = providerId;
    const handle = z.string().regex(/^[a-zA-Z0-9._]{1,30}$/).parse(user.username);
    stage = 'messaging_subscription';
    const subscription = await json(await request(`https://graph.instagram.com/${version}/${providerId}/subscribed_apps`, { method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}` }, body: new URLSearchParams({ subscribed_fields: 'messages' }), signal: AbortSignal.timeout(15_000) }), stage, secrets);
    if (subscription.success !== true) throw new ConnectionFailure(stage, 'invalid_response');
    stage = 'save_account';
    return await saveMessagingConnection(env, 'instagram', profileId, { providerAccountId: providerId, handle,
      credentials: { accessToken: token.accessToken, expiresAt: token.expiresAt, scopes: ['instagram_business_basic', 'instagram_business_manage_messages'] } });
  } catch (error) {
    const failure = error instanceof ConnectionFailure ? error : new ConnectionFailure(stage,
      error instanceof AccountAssignmentError ? 'account_already_assigned' : error instanceof z.ZodError ? 'invalid_response' : 'network_or_internal');
    failure.validatedState = true;
    failure.distribuidoraId = profileId;
    failure.providerAccountId = providerAccountId;
    if (failure.kind !== 'account_already_assigned') {
      try {
        const resumeUntil = input.resumeUntil ?? new Date(Date.now() + 600_000).toISOString();
        const checkpointId = `instagram-pending:${profileId}:${crypto.randomUUID()}`;
        await vaultFor(env).put(checkpointId, { accessToken: token.accessToken, ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
          ...(token.grantedPermissions ? { scopes: token.grantedPermissions } : {}),
          checkpoint: { provider: 'instagram', distribuidoraId: profileId, kind: token.kind, resumeUntil } });
        failure.checkpointId = checkpointId;
      } catch { /* Preserve the original safe failure if checkpoint storage is unavailable. */ }
    }
    throw failure;
  }
}

export class ConnectionRetryError extends Error {}
export async function retryInstagramConnection(env: Env, reference: string, request: typeof fetch = fetch, inspectOnly = false) {
  if (!env.DB) throw new ConnectionRetryError('Database required');
  if (!env.INSTAGRAM_OAUTH_CLIENT_ID || !env.INSTAGRAM_OAUTH_CLIENT_SECRET) throw new ConnectionRetryError('Configure the Instagram app credentials before retrying');
  const row = await env.DB.prepare("SELECT detail FROM operational_alerts WHERE kind='instagram_connection_failed' AND resource_id=?")
    .bind(reference).first<{ detail: string }>();
  if (!row) throw new ConnectionRetryError('Diagnostic reference not found');
  const detail = z.object({ distribuidoraId: z.string(), checkpointId: z.string().optional() }).parse(JSON.parse(row.detail));
  if (!detail.checkpointId?.startsWith(`instagram-pending:${detail.distribuidoraId}:`)) throw new ConnectionRetryError('This attempt has no encrypted retry checkpoint. A fresh invitation is required.');
  return withLease(env.DB, `resume:${detail.checkpointId}`, async () => {
    const value = await vaultFor(env).get(detail.checkpointId!);
    const checkpoint = value?.checkpoint;
    if (!value || !checkpoint || checkpoint.provider !== 'instagram' || checkpoint.distribuidoraId !== detail.distribuidoraId
      || Date.parse(checkpoint.resumeUntil) <= Date.now() || (value.expiresAt && Date.parse(value.expiresAt) <= Date.now())) {
      throw new ConnectionRetryError('The encrypted retry checkpoint expired. A fresh invitation is required.');
    }
    if (!(await new AccountStore(env.DB!).get(detail.distribuidoraId))?.active) throw new ConnectionRetryError('This distribuidora is inactive');
    if (inspectOnly) {
      const response = await request(`https://graph.instagram.com/${env.META_GRAPH_API_VERSION}/me?fields=user_id,username`, {
        headers: { Authorization: `Bearer ${value.accessToken}` }, signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => null);
      return { checkpointInspection: { kind: checkpoint.kind,
        tokenFamily: value.accessToken.startsWith('IG') ? 'instagram' : value.accessToken.startsWith('EA') ? 'facebook' : 'unknown',
        tokenLength: value.accessToken.length, hasWhitespace: /\s/.test(value.accessToken), identityStatus: response.status,
        resumeUntil: checkpoint.resumeUntil, grantedPermissions: value.scopes?.filter((permission) => knownInstagramPermissions.has(permission)) ?? null,
        ...(response.ok ? { identity: z.object({ user_id: instagramId.optional(), id: instagramId.optional(), username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/).optional() }).parse(body) }
          : providerFailure('account_identity', response.status, body, [value.accessToken, env.INSTAGRAM_OAUTH_CLIENT_SECRET!]).details) } };
    }
    const accountId = await finishInstagramToken(env, detail.distribuidoraId, { kind: checkpoint.kind, accessToken: value.accessToken,
      expiresAt: value.expiresAt, resumeUntil: checkpoint.resumeUntil, grantedPermissions: value.scopes?.filter((permission) => knownInstagramPermissions.has(permission)) }, request);
    await env.DB!.prepare('DELETE FROM account_credentials WHERE id=?').bind(detail.checkpointId!).run();
    await resolveAlert(env.DB!, 'instagram_connection_failed', reference);
    return { accountId, distribuidoraId: detail.distribuidoraId };
  });
}

/** Connect an existing Cloud API number, not an arbitrary personal WhatsApp number. */
export async function connectWhatsApp(env: Env, distribuidoraId: string, input: unknown, request: typeof fetch = fetch) {
  const data = z.object({ phoneNumberId: z.string().regex(/^\d+$/), accessToken: z.string().min(1), expiresAt: z.string().datetime().optional() }).strict().parse(input);
  if (!/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION ?? '')) throw new Error('Meta API version required');
  const verified = await json(await request(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${data.phoneNumberId}?fields=id,display_phone_number`, {
    headers: { Authorization: `Bearer ${data.accessToken}` }, signal: AbortSignal.timeout(15_000) }));
  if (String(verified.id) !== data.phoneNumberId || typeof verified.display_phone_number !== 'string') throw new Error('Cloud API number could not be verified');
  return saveMessagingConnection(env, 'whatsapp', distribuidoraId, { providerAccountId: data.phoneNumberId, handle: verified.display_phone_number,
    credentials: { accessToken: data.accessToken, ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}) } });
}
