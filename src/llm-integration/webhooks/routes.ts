import { Hono } from 'hono';
import { handleWebhookChallenge, processMetaWebhook } from '../../channels/meta.js';
import type { Env } from '../../types/env.js';

/** HTTP transport only. The shared Meta adapter still owns payload handling. */
export function createWebhookRoutes() {
  const routes = new Hono<{ Bindings: Env }>();
  routes.get('/', handleWebhookChallenge);
  routes.post('/', async (c) => {
    const result = await processMetaWebhook(
      await c.req.text(), c.req.header('x-hub-signature-256'), c.env, c.executionCtx,
    );
    // processMetaWebhook currently returns these three statuses.
    const status = result.status === 200 ? 200 : result.status === 400 ? 400 : result.status === 401 ? 401 : 500;
    return c.text(result.message, status);
  });
  return routes;
}
