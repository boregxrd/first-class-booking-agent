import { Context } from 'hono';
import { InboundMessage } from '../../model.js';
import { createServices } from '../runtime/factory.js';
import { Env } from '../types/env.js';
import {
  InstagramMessagingEvent,
  InstagramWebhookPayload,
  MetaWebhookPayload,
  WhatsAppContact,
  WhatsAppIncomingMessage,
  WhatsAppMetadata,
  WhatsAppStatus,
  WhatsAppWebhookPayload,
} from '../types/meta.js';
import { sendInstagramReply, sendWhatsAppText } from './outbound.js';

// ============================================================================
// SIGNATURE & AUTHENTICATION HELPERS
// ============================================================================

/**
 * Validates Meta's webhook verification challenge (GET /webhook)
 */
export function handleWebhookChallenge(c: Context<{ Bindings: Env }>) {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  const configuredVerifyToken = c.env.META_VERIFY_TOKEN;

  if (!configuredVerifyToken) {
    console.error('[Meta Webhook] META_VERIFY_TOKEN is not configured in environment.');
    return c.text('Server Misconfigured', 500);
  }

  if (mode === 'subscribe' && token === configuredVerifyToken && challenge) {
    console.log('[Meta Webhook] Verification challenge succeeded.');
    return c.text(challenge, 200);
  }

  console.warn('[Meta Webhook] Verification challenge failed. Tokens do not match.');
  return c.text('Forbidden', 403);
}

/**
 * Validates Meta's HMAC-SHA256 payload signature (POST /webhook)
 */
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string
): Promise<boolean> {
  if (!appSecret) {
    console.warn('[Meta Webhook] META_APP_SECRET is not configured. Rejecting request.');
    return false;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = signatureHeader.slice(7);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const signatureHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return signatureHex === expectedSignature;
}

// ============================================================================
// INBOUND EVENT HANDLERS
// ============================================================================

/**
 * Handles incoming Instagram Direct Message events.
 */
export async function handleInstagramMessage(
  event: InstagramMessagingEvent,
  env: Env,
  ctx?: unknown
): Promise<void> {
  if (event.message?.is_echo || !event.message?.text) {
    return;
  }

  const senderId = event.sender.id;
  const recipientId = event.recipient.id;
  const messageText = event.message.text;
  const messageId = event.message.mid;
  const now = new Date().toISOString();

  const inbound: InboundMessage = {
    identity: {
      channel: 'instagram',
      businessAccountId: recipientId,
      senderId,
    },
    providerMessageId: messageId,
    sentAt: new Date(event.timestamp).toISOString(),
    receivedAt: now,
    text: messageText,
  };

  const services = createServices(env);

  try {
    const turnResult = await services.processor(inbound);
    console.log(`[Instagram] Processed turn: ${turnResult.bookingStatus}. Sending reply.`);

    if (env.META_ACCESS_TOKEN && turnResult.reply) {
      await sendInstagramReply(senderId, turnResult.reply, env.META_ACCESS_TOKEN);
    }
  } catch (err) {
    console.error('[Instagram] Error processing message:', err);
  }
}

/**
 * Handles incoming WhatsApp Cloud API messages.
 */
export async function handleWhatsAppMessage(
  message: WhatsAppIncomingMessage,
  metadata: WhatsAppMetadata,
  contacts: WhatsAppContact[] | undefined,
  env: Env,
  ctx?: unknown
): Promise<void> {
  if (message.type !== 'text' || !message.text?.body) {
    return;
  }

  const now = new Date().toISOString();
  const inbound: InboundMessage = {
    identity: {
      channel: 'whatsapp',
      businessAccountId: metadata.phone_number_id,
      senderId: message.from,
    },
    providerMessageId: message.id,
    sentAt: new Date(parseInt(message.timestamp, 10) * 1000).toISOString(),
    receivedAt: now,
    text: message.text.body,
  };

  const services = createServices(env);

  try {
    const turnResult = await services.processor(inbound);
    console.log(`[WhatsApp] Processed turn: ${turnResult.bookingStatus}. Sending reply.`);

    if (env.META_ACCESS_TOKEN && turnResult.reply) {
      await sendWhatsAppText(message.from, turnResult.reply, metadata.phone_number_id, env.META_ACCESS_TOKEN);
    }
  } catch (err) {
    console.error('[WhatsApp] Error processing message:', err);
  }
}

/**
 * Handles WhatsApp delivery and read status callbacks.
 */
export async function handleWhatsAppStatus(
  status: WhatsAppStatus,
  businessAccountId: string,
  env: Env,
  ctx?: unknown
): Promise<void> {
  console.log(`[WhatsApp Status] Message ${status.id} status changed to: ${status.status}`);

  const services = createServices(env);
  if (services.statusHandler) {
    await services.statusHandler.handleDeliveryUpdate({
      businessAccountId,
      providerMessageId: status.id,
      status: status.status,
      occurredAt: new Date(parseInt(status.timestamp, 10) * 1000).toISOString(),
      errorCode: status.errors?.[0]?.code?.toString(),
    });
  }
}

// ============================================================================
// MAIN WEBHOOK POST DISPATCHER
// ============================================================================

/**
 * Validates signature, parses body, and routes Meta webhook events.
 */
export async function processMetaWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  env: Env,
  ctx?: unknown
): Promise<{ status: number; message: string }> {
  // 1. Verify HMAC-SHA256 signature
  const isSignatureValid = await verifyMetaSignature(rawBody, signatureHeader, env.META_APP_SECRET);
  if (!isSignatureValid) {
    console.warn('[Meta Webhook] Signature verification failed.');
    return { status: 401, message: 'Unauthorized: Invalid Signature' };
  }

  // 2. Parse payload JSON
  let body: MetaWebhookPayload;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, message: 'Invalid JSON' };
  }

  // 3. Route Instagram events
  if (body.object === 'instagram') {
    const igPayload = body as InstagramWebhookPayload;
    for (const entry of igPayload.entry || []) {
      for (const event of entry.messaging || []) {
        if (event.message) {
          await handleInstagramMessage(event, env, ctx);
        }
      }
    }
  }

  // 4. Route WhatsApp Cloud API events
  if (body.object === 'whatsapp_business_account') {
    const waPayload = body as WhatsAppWebhookPayload;
    for (const entry of waPayload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'messages' && change.value) {
          const { metadata, contacts, messages, statuses } = change.value;

          if (messages && messages.length > 0) {
            for (const message of messages) {
              await handleWhatsAppMessage(message, metadata, contacts, env, ctx);
            }
          }

          if (statuses && statuses.length > 0) {
            for (const status of statuses) {
              await handleWhatsAppStatus(status, metadata.phone_number_id, env, ctx);
            }
          }
        }
      }
    }
  }

  return { status: 200, message: 'EVENT_RECEIVED' };
}
