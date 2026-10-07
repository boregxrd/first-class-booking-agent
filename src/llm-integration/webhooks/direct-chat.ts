import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types/env.js';
import { createServices } from '../../runtime/factory.js';
import { DIRECT_CHAT_ACCOUNT } from '../runtime/direct-chat.js';
import { ConversationBusyError } from '../runtime/persistence.js';
import { ModelRequestError } from '../agent/client.js';
import type { BookingService, InboundMessage } from '../../../model.js';
import type { TurnResult } from '../conversations/store.js';
import type { RosterCalendar } from '../../calendar/client.js';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const inputSchema = z.object({
  conversationId: identifier,
  messageId: identifier,
  text: z.string().trim().min(1).max(4000),
}).strict();

async function authorized(header: string | undefined, token: string) {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [actual, expected] = await Promise.all([digest(header ?? ''), digest(`Bearer ${token}`)]);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i]! ^ expected[i]!;
  return difference === 0;
}

/** Synchronous operator test transport; shares the real agent, D1 store and booking service. */
export function createDirectChatRoutes(makeServices: (env: Env) => {
  processor: (message: InboundMessage) => Promise<TurnResult>;
  bookings: BookingService;
  calendarClient: RosterCalendar | null;
} = createServices) {
  const routes = new Hono<{ Bindings: Env }>();
  routes.post('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!c.env.DIRECT_CHAT_TOKEN) return c.json({ error: 'Direct chat is disabled' }, 404);
    if (!await authorized(c.req.header('Authorization'), c.env.DIRECT_CHAT_TOKEN)) return c.json({ error: 'Unauthorized' }, 401);
    // Bound the actual streamed body, including requests without Content-Length.
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 24 * 1024) { await reader.cancel(); return c.json({ error: 'Payload too large' }, 413); }
      chunks.push(value);
    }
    let input: z.infer<typeof inputSchema>;
    try {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      input = inputSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)));
    } catch { return c.json({ error: 'Expected conversationId, messageId and text (1–4000 characters)' }, 400); }
    if (!c.env.DB || !c.env.OPENAI_API_KEY || !c.env.GOOGLE_CALENDAR_ID || !c.env.GOOGLE_CLIENT_EMAIL || !c.env.GOOGLE_PRIVATE_KEY) {
      return c.json({ error: 'D1, OpenAI and Google Calendar must be configured' }, 503);
    }
    const identity = { channel: 'instagram' as const, businessAccountId: DIRECT_CHAT_ACCOUNT, senderId: input.conversationId };
    const now = new Date().toISOString();
    try {
      const services = makeServices(c.env);
      const result = await services.processor({ identity, providerMessageId: `${input.conversationId}:${input.messageId}`, text: input.text, sentAt: now, receivedAt: now });
      const customer = await c.env.DB.prepare('SELECT customer_id FROM channel_identities WHERE channel = ? AND business_account_id = ? AND sender_id = ?')
        .bind(identity.channel, identity.businessAccountId, identity.senderId).first<{ customer_id: string }>();
      const latest = customer ? await c.env.DB.prepare('SELECT id FROM bookings WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
        .bind(customer.customer_id).first<{ id: string }>() : null;
      const booking = customer && latest ? await services.bookings.getBooking({ customerId: customer.customer_id, conversationId: input.conversationId, sourceMessageId: input.messageId, requestedAt: now }, latest.id) : null;
      const calendarEvent = booking?.calendar && services.calendarClient ? await services.calendarClient.getEvent(booking.calendar.eventId) : null;
      return c.json({ conversationId: input.conversationId, messageId: input.messageId, ...result, booking, calendarEvent });
    } catch (error) {
      if (error instanceof ConversationBusyError) return c.json({ error: 'Conversation busy; retry the same messageId' }, 409);
      if (error instanceof ModelRequestError) return c.json({ error: 'OpenAI request failed', providerStatus: error.status, retryable: error.retryable }, 502);
      console.error('[Direct chat failed]', { conversationId: input.conversationId, messageId: input.messageId });
      return c.json({ error: 'Turn failed; retry the same messageId' }, 503);
    }
  });
  return routes;
}
