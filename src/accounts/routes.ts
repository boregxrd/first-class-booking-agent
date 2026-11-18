import { Hono } from 'hono';
import { z } from 'zod';
import { html } from 'hono/html';
import type { Env } from '../types/env.js';
import { ownerAuthorized } from './auth.js';
import { AccountStore } from './store.js';
import { bootstrapLegacyAccounts, vaultFor } from './runtime.js';
import { completeConnection, connectWhatsApp, startConnection, retryInstagramConnection, ConnectionRetryError } from './connections.js';
import { GoogleOwnerCalendars, ownerGoogleToken } from './google-owner.js';
import { provisionCalendar } from './provisioning.js';
import { portalHtml, portalScript } from './portal.js';
import { emailInstagramInvitation, inspectInvitation, openInstagramInvitation, invitationEmailAuthorized, InvitationSetupError } from './invitation-email.js';
import { ConnectionFailure } from './connection-errors.js';
import { alert } from '../llm-integration/runtime/persistence.js';

async function recordConnectionFailure(env: Env, error: ConnectionFailure) {
  if (!error.validatedState || !env.DB) return '';
  const reference = crypto.randomUUID();
  try {
    await alert(env.DB, 'instagram_connection_failed', reference, JSON.stringify({ stage: error.stage, kind: error.kind,
      distribuidoraId: error.distribuidoraId, providerAccountId: error.providerAccountId, checkpointId: error.checkpointId, ...error.details }));
  } catch { console.warn('[Instagram connection diagnostic unavailable]', { reference, stage: error.stage, kind: error.kind }); }
  return reference;
}

export function createAccountRoutes() {
  const routes = new Hono<{ Bindings: Env }>();
  routes.onError((_error, c) => c.json({ error: 'Owner operation failed; inspect configuration and setup status' }, 400));
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    await next();
  });
  routes.get('/admin', (c) => c.html(portalHtml));
  routes.get('/admin/app.js', (c) => c.body(portalScript, 200, { 'Content-Type': 'application/javascript; charset=utf-8' }));
  routes.use('/admin/api/*', async (c, next) => {
    if (!await ownerAuthorized(c.req.raw, c.env)) return c.json({ error: 'Owner authorization required' }, 401);
    if (!c.env.DB) return c.json({ error: 'Database is not configured' }, 503);
    if (!['GET', 'HEAD'].includes(c.req.method) && !c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'JSON request required' }, 415);
    try { await next(); }
    catch (error) {
      console.warn('[Owner operation failed]', { path: c.req.routePath });
      return c.json({ error: error instanceof z.ZodError ? 'Invalid input' : 'Operation could not complete. Check provider configuration and setup status; do not repeat ambiguous calendar creation.' }, 400);
    }
  });
  routes.get('/admin/api/overview', async (c) => {
    const store = new AccountStore(c.env.DB!);
    return c.json({ profiles: await store.list(), accounts: await store.publicAccounts(), reminderSender: await store.setting('reminder_sender_account_id'),
      invitations: (await c.env.DB!.prepare('SELECT id,distribuidora_id,recipient,state,expires_at,opened_at,created_at FROM connection_invitation_emails ORDER BY created_at DESC LIMIT 100').all()).results,
      generalProfileId: await store.setting('general_distribuidora_id') ?? 'dwc', multiAccountEnabled: c.env.MULTI_ACCOUNT_ENABLED === 'true',
      setup: { googleOAuthConfigured: Boolean(c.env.GOOGLE_OAUTH_CLIENT_ID && c.env.GOOGLE_OAUTH_CLIENT_SECRET && c.env.GOOGLE_OWNER_EMAIL),
        instagramOAuthConfigured: Boolean(c.env.INSTAGRAM_OAUTH_CLIENT_ID && c.env.INSTAGRAM_OAUTH_CLIENT_SECRET),
        invitationEmailAuthorized: await invitationEmailAuthorized(c.env) } });
  });
  routes.post('/admin/api/profiles', async (c) => {
    const profile = await new AccountStore(c.env.DB!).create(await c.req.json(), c.req.header('Idempotency-Key'));
    if (profile.calendar_setup_status === 'ready') return c.json({ profile, setupPending: false });
    try {
      await ownerGoogleToken(c.env);
      const ready = await provisionCalendar(c.env.DB!, profile.id, c.env.GOOGLE_CLIENT_EMAIL ?? '', new GoogleOwnerCalendars(c.env));
      return c.json({ profile: ready, setupPending: false }, 201);
    } catch { return c.json({ profile: await new AccountStore(c.env.DB!).get(profile.id), setupPending: true }, 202); }
  });
  routes.post('/admin/api/profiles/:id/provision', async (c) => {
    await ownerGoogleToken(c.env);
    return c.json({ profile: await provisionCalendar(c.env.DB!, c.req.param('id'), c.env.GOOGLE_CLIENT_EMAIL ?? '', new GoogleOwnerCalendars(c.env)) });
  });
  routes.get('/admin/api/profiles/:id/calendar', async (c) => {
    const profile = await new AccountStore(c.env.DB!).get(c.req.param('id'));
    if (!profile?.google_calendar_id) return c.json({ error: 'This profile has no provisioned calendar' }, 404);
    return c.json({ profileId: profile.id, setupStatus: profile.calendar_setup_status, calendarViewUrl: profile.calendar_view_url,
      calendar: await new GoogleOwnerCalendars(c.env).inspect(profile.google_calendar_id) });
  });
  routes.post('/admin/api/profiles/:id/active', async (c) => {
    const { active } = z.object({ active: z.boolean() }).strict().parse(await c.req.json());
    await new AccountStore(c.env.DB!).setActive(c.req.param('id'), active); return c.json({ ok: true });
  });
  routes.post('/admin/api/bootstrap', async (c) => { await bootstrapLegacyAccounts(c.env); return c.json({ ok: true }); });
  routes.post('/admin/api/rotate-credentials', async (c) => {
    const { after } = z.object({ after: z.string().default('') }).strict().parse(await c.req.json());
    const rows = await c.env.DB!.prepare('SELECT id FROM account_credentials WHERE id>? ORDER BY id LIMIT 20').bind(after).all<{ id: string }>();
    for (const row of rows.results) await vaultFor(c.env).rotate(row.id);
    return c.json({ rotated: rows.results.length, nextCursor: rows.results.at(-1)?.id ?? null });
  });
  routes.post('/admin/api/connections/start', async (c) => {
    const input = z.object({ provider: z.enum(['google', 'instagram']), distribuidoraId: z.string().min(1).optional() }).strict().parse(await c.req.json());
    if (input.provider === 'google' && (!c.env.GOOGLE_OAUTH_CLIENT_ID || !c.env.GOOGLE_OAUTH_CLIENT_SECRET || !c.env.GOOGLE_OWNER_EMAIL)) {
      return c.json({ error: 'Google OAuth is not configured. Create a Web application client and import its downloaded JSON with scripts/owner.mjs --google-client <path>.' }, 503);
    }
    return c.json(await startConnection(c.env, input.provider, input.distribuidoraId ?? null));
  });
  routes.post('/admin/api/profiles/:id/instagram-invitation', async (c) => {
    const requestId = z.string().uuid().parse(c.req.header('Idempotency-Key'));
    try {
      const result = await emailInstagramInvitation(c.env, c.req.param('id'), requestId);
      return c.json({ ...result, ...(result.state === 'rejected' ? { error: 'Gmail rejected the invitation email. Verify Gmail API is enabled and the gym Google account authorized email sending.' } : {}) },
        result.state === 'accepted' ? 200 : result.state === 'rejected' ? 502 : 202);
    } catch (error) {
      if (error instanceof InvitationSetupError) return c.json({ error: error.message }, 503);
      throw error;
    }
  });
  routes.post('/admin/api/connections/retry-instagram', async (c) => {
    const { reference, inspectOnly } = z.object({ reference: z.string().uuid(), inspectOnly: z.boolean().default(false) }).strict().parse(await c.req.json());
    try { return c.json(await retryInstagramConnection(c.env, reference, fetch, inspectOnly)); }
    catch (error) {
      if (error instanceof ConnectionRetryError) return c.json({ error: error.message }, 409);
      if (error instanceof ConnectionFailure) {
        const nextReference = await recordConnectionFailure(c.env, error);
        return c.json({ error: `${error.publicMessage()} Reference: ${nextReference}`, reference: nextReference }, 400);
      }
      throw error;
    }
  });
  routes.post('/admin/api/profiles/:id/whatsapp', async (c) => {
    const id = await connectWhatsApp(c.env, c.req.param('id'), await c.req.json()); return c.json({ accountId: id });
  });
  routes.post('/admin/api/accounts/:id/disconnect', async (c) => { await new AccountStore(c.env.DB!).disconnect(c.req.param('id')); return c.json({ ok: true }); });
  routes.post('/admin/api/reminder-sender', async (c) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).strict().parse(await c.req.json());
    const store = new AccountStore(c.env.DB!);
    const account = await c.env.DB!.prepare("SELECT id FROM social_accounts WHERE id=? AND platform='whatsapp' AND status='connected' AND distribuidora_id=?")
      .bind(accountId, await store.setting('general_distribuidora_id') ?? 'dwc').first();
    if (!account) return c.json({ error: 'Select a connected WhatsApp account belonging to the gym record' }, 400);
    await store.setSetting('reminder_sender_account_id', accountId); return c.json({ ok: true });
  });
  routes.get('/connect/instagram/:token', async (c) => {
    const invitation = await inspectInvitation(c.env, c.req.param('token'));
    if (!invitation) return c.text('This invitation expired, was already used or is unavailable. Ask the gym for a new invitation email.', 410);
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://www.instagram.com; frame-ancestors 'none'; base-uri 'none'");
    return c.html(html`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar Instagram · DWC</title>
      <body><h1>Dallas Wellness Club</h1><p>Hola ${invitation.name}. Conecta tu cuenta profesional de Instagram a tu perfil y calendario de reservas.</p>
      <p>No necesitas iniciar sesión en el portal de propietarios. Al continuar, Instagram te pedirá autorizar acceso a los mensajes.</p>
      <form method="post" action="/connect/instagram/${c.req.param('token')}"><button>Conectar Instagram</button></form></body></html>`);
  });
  routes.post('/connect/instagram/:token', async (c) => {
    c.header('Content-Security-Policy', "default-src 'none'; form-action 'self' https://www.instagram.com; frame-ancestors 'none'; base-uri 'none'");
    try { return c.redirect(await openInstagramInvitation(c.env, c.req.param('token')), 303); }
    catch { return c.text('This invitation could not start Instagram authorization. It may be expired or already used. Ask the gym for help.', 410); }
  });
  routes.get('/connections/callback/:provider', async (c) => {
    try {
      const provider = z.enum(['google', 'instagram']).parse(c.req.param('provider'));
      if (c.req.query('error')) return c.text('Authorization was declined. Ask the owner for a new connection link.', 400);
      await completeConnection(c.env, provider, c.req.query('state') ?? '', c.req.query('code') ?? '');
      return c.text('Authorization saved. You can close this window. The owner can refresh the DWC portal.');
    } catch (error) {
      if (error instanceof ConnectionFailure) {
        const reference = await recordConnectionFailure(c.env, error);
        return c.text(`${error.publicMessage()}${reference ? ` Reference: ${reference}` : ''}`, 400);
      }
      return c.text('Authorization could not complete. Ask the owner to check provider configuration and generate a fresh link.', 400);
    }
  });
  return routes;
}
