import type { Context } from 'hono';
import { z } from 'zod';
import type { InboundMessage, NotificationDeliveryUpdate } from '../../model.js';
import type { Env } from '../types/env.js';
import { canProcessMessages } from '../llm-integration/runtime/test-access.js';
import { ingest } from '../llm-integration/runtime/inbox.js';
import { D1NotificationStatusHandler } from '../notifications/scheduler.js';
import { isOptOut, revokeNotifications } from '../llm-integration/conversations/controls.js';

const id = z.string().min(1).max(512);
const timestamp = z.number().finite().nonnegative().max(8.64e15);
const instagram = z.object({
  object: z.literal('instagram'),
  entry: z.array(z.object({ messaging: z.array(z.object({
    sender: z.object({ id }), recipient: z.object({ id }), timestamp,
    message: z.object({ mid: id, text: z.string().max(4000).optional(), is_echo: z.boolean().optional() }).optional(),
  })).max(100).optional() })).max(100),
});
const whatsapp = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({ changes: z.array(z.object({
    field: z.string(), value: z.object({
      metadata: z.object({ phone_number_id: id }),
      messages: z.array(z.object({ id, from: id, timestamp: z.string().regex(/^\d{1,12}$/), type: z.string(), text: z.object({ body: z.string().max(4000) }).optional() })).max(100).optional(),
      statuses: z.array(z.object({ id, status: z.enum(['sent', 'delivered', 'read', 'failed']), timestamp: z.string().regex(/^\d{1,12}$/),
        biz_opaque_callback_data: z.string().max(512).optional(),
        errors: z.array(z.object({ code: z.number() })).optional(),
      })).max(100).optional(),
    }),
  })).max(100) })).max(100),
});

export function handleWebhookChallenge(c: Context<{ Bindings: Env }>) {
  if (!c.env.META_VERIFY_TOKEN) return c.text('Server Misconfigured', 500);
  const challenge = c.req.query('hub.challenge');
  return c.req.query('hub.mode') === 'subscribe' && c.req.query('hub.verify_token') === c.env.META_VERIFY_TOKEN && challenge
    ? c.text(challenge, 200) : c.text('Forbidden', 403);
}

export async function verifyMetaSignature(rawBody: string, header: string | undefined, secret: string): Promise<boolean> {
  if (!secret || !header || !/^sha256=[a-fA-F0-9]{64}$/.test(header)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(header.slice(7).match(/../g)!, (byte) => parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(rawBody));
}

export async function processMetaWebhook(rawBody: string, signature: string | undefined, env: Env, _ctx?: unknown): Promise<{ status: 200 | 400 | 401 | 413 | 503; message: string }> {
  if (new TextEncoder().encode(rawBody).length > 256 * 1024) return { status: 413, message: 'Payload too large' };
  if (!await verifyMetaSignature(rawBody, signature, env.META_APP_SECRET)) return { status: 401, message: 'Invalid signature' };
  let body: z.infer<typeof instagram> | z.infer<typeof whatsapp>;
  try { body = z.union([instagram, whatsapp]).parse(JSON.parse(rawBody)); }
  catch { return { status: 400, message: 'Invalid webhook payload' }; }
  const now = new Date().toISOString();
  const messages: InboundMessage[] = [];
  const updates: NotificationDeliveryUpdate[] = [];
  if (body.object === 'instagram') {
    for (const entry of body.entry) for (const event of entry.messaging ?? []) {
      if (!event.message || event.message.is_echo || event.sender.id === event.recipient.id) continue;
      messages.push({ identity: { channel: 'instagram', businessAccountId: event.recipient.id, senderId: event.sender.id },
        providerMessageId: event.message.mid, text: event.message.text?.trim() || '[unsupported media]',
        sentAt: new Date(event.timestamp).toISOString(), receivedAt: now });
    }
  } else {
    for (const entry of body.entry) for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const account = change.value.metadata.phone_number_id;
      for (const message of change.value.messages ?? []) messages.push({
        identity: { channel: 'whatsapp', businessAccountId: account, senderId: message.from },
        providerMessageId: message.id, text: message.type === 'text' && message.text?.body.trim() ? message.text.body : '[unsupported media]',
        sentAt: new Date(Number(message.timestamp) * 1000).toISOString(), receivedAt: now,
      });
      for (const status of change.value.statuses ?? []) updates.push({ businessAccountId: account, providerMessageId: status.id,
        status: status.status, occurredAt: new Date(Number(status.timestamp) * 1000).toISOString(), errorCode: status.errors?.[0]?.code.toString(), correlationId: status.biz_opaque_callback_data });
    }
  }
  if (messages.some((message) => Date.parse(message.sentAt) > Date.parse(now) + 300_000)) return { status: 400, message: 'Invalid message timestamp' };
  const accepted = messages.filter((message) => {
    if (!canProcessMessages(message.identity, env)) {
      console.info('[Webhook observed]', { channel: message.identity.channel, senderId: message.identity.senderId, account: message.identity.businessAccountId });
      return false;
    }
    const account = message.identity.channel === 'instagram' ? env.META_INSTAGRAM_ACCOUNT_ID : env.META_WHATSAPP_PHONE_NUMBER_ID;
    return Boolean(account && account === message.identity.businessAccountId);
  });
  if (messages.some((message) => canProcessMessages(message.identity, env)
    && !(message.identity.channel === 'instagram' ? env.META_INSTAGRAM_ACCOUNT_ID : env.META_WHATSAPP_PHONE_NUMBER_ID))) {
    return { status: 503, message: 'Channel account not configured' };
  }
  try {
    if (accepted.length) {
      if (!env.DB) return { status: 503, message: 'Database not configured' };
      for (const message of accepted) if (isOptOut(message.text)) await revokeNotifications(env.DB, message.identity, now);
      await ingest(env.DB, accepted, env.MESSAGE_QUEUE);
    }
    for (const update of updates.filter((update) => update.businessAccountId === env.META_WHATSAPP_PHONE_NUMBER_ID)) {
      if (!env.DB) return { status: 503, message: 'Database not configured' };
      await new D1NotificationStatusHandler(env.DB).handleDeliveryUpdate(update);
    }
  } catch { return { status: 503, message: 'Ingestion unavailable; retry delivery' }; }
  return { status: 200, message: 'EVENT_RECEIVED' };
}
