import { Hono } from 'hono';
import { handleWebhookChallenge, processMetaWebhook } from '../../channels/meta.js';
import type { Env } from '../../types/env.js';

/** HTTP transport only. The shared Meta adapter still owns payload handling. */
export function createWebhookRoutes() {
  const routes = new Hono<{ Bindings: Env }>();
  routes.get('/', handleWebhookChallenge);
  routes.post('/', async (c) => {
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) { await reader.cancel(); return c.text('Payload too large', 413); }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body: string;
    try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return c.text('Invalid UTF-8', 400); }
    const result = await processMetaWebhook(
      body, c.req.header('x-hub-signature-256'), c.env, c.executionCtx,
    );
    return c.text(result.message, result.status);
  });
  return routes;
}
