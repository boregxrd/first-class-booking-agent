import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types/env.js';
import { ownerAuthorized } from './auth.js';
import { AccountStore } from './store.js';
import { bootstrapLegacyAccounts, vaultFor } from './runtime.js';
import { completeConnection, connectWhatsApp, startConnection } from './connections.js';
import { GoogleOwnerCalendars, ownerGoogleToken } from './google-owner.js';
import { provisionCalendar } from './provisioning.js';
import { portalHtml, portalScript } from './portal.js';

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
      generalProfileId: await store.setting('general_distribuidora_id') ?? 'dwc', multiAccountEnabled: c.env.MULTI_ACCOUNT_ENABLED === 'true',
      setup: { googleOAuthConfigured: Boolean(c.env.GOOGLE_OAUTH_CLIENT_ID && c.env.GOOGLE_OAUTH_CLIENT_SECRET && c.env.GOOGLE_OWNER_EMAIL) } });
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
  routes.get('/connections/callback/:provider', async (c) => {
    try {
      const provider = z.enum(['google', 'instagram']).parse(c.req.param('provider'));
      if (c.req.query('error')) return c.text('Authorization was declined. Ask the owner for a new connection link.', 400);
      await completeConnection(c.env, provider, c.req.query('state') ?? '', c.req.query('code') ?? '');
      return c.text('Authorization saved. You can close this window. The owner can refresh the DWC portal.');
    } catch { return c.text('Authorization could not complete or this link expired. Ask the owner for a new connection link.', 400); }
  });
  return routes;
}
