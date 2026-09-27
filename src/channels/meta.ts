import { Context } from 'hono';
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

  // Ensure verify token is set and matches
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

  const expectedSignature = signatureHeader.slice(7); // Remove 'sha256='
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
 *
 * Key fields received:
 * - `event.sender.id`: Instagram-Scoped ID (IGSID) of the sender.
 * - `event.recipient.id`: Your Instagram business account ID.
 * - `event.timestamp`: Milliseconds timestamp.
 * - `event.message.mid`: Unique message ID.
 * - `event.message.text`: Message text content (if text).
 * - `event.message.attachments`: Array of media (image, video, audio, stories).
 * - `event.message.is_echo`: true if message was sent by your own business account.
 * - `event.message.reply_to.mid`: Parent message ID if quoting a previous message.
 */
export async function handleInstagramMessage(
  event: InstagramMessagingEvent,
  env: Env,
  ctx?: unknown
): Promise<void> {
  // Ignore echo messages (outbound messages sent by business account from other devices)
  if (event.message?.is_echo) {
    return;
  }

  const senderId = event.sender.id;
  const messageText = event.message?.text;
  console.log(`[Instagram] Inbound message from IGSID: ${senderId} - "${messageText ?? '[Media/Action]'}"`);

  // TODO (Person 1 / Agent):
  // 1. Durably enqueue or serialize message processing.
  // 2. Load conversation state & invoke tool-calling LLM.
  // 3. Send outbound reply via Meta Graph API.
}

/**
 * Handles incoming WhatsApp Cloud API messages.
 *
 * Key fields received:
 * - `message.from`: Customer's WhatsApp phone number (wa_id).
 * - `message.id`: WhatsApp message ID (`wamid.HB...`).
 * - `message.type`: `'text' | 'image' | 'audio' | 'video' | 'interactive' | ...`
 * - `message.text.body`: Text message body.
 * - `message.context.id`: Referenced message ID if customer replied to a quote.
 * - `metadata.phone_number_id`: Your business phone number ID for API replies.
 * - `contacts`: Customer's profile name and matching `wa_id`.
 */
export async function handleWhatsAppMessage(
  message: WhatsAppIncomingMessage,
  metadata: WhatsAppMetadata,
  contacts: WhatsAppContact[] | undefined,
  env: Env,
  ctx?: unknown
): Promise<void> {
  const senderContact = contacts?.find((c) => c.wa_id === message.from);
  const senderName = senderContact?.profile.name || 'Prospect';
  const textBody = message.text?.body;

  console.log(`[WhatsApp] Inbound message from ${senderName} (${message.from}): "${textBody ?? `[${message.type}]`}"`);

  // TODO (Person 1 / Agent):
  // 1. Process customer message against BookingService.
  // 2. Invoke LLM and send WhatsApp in-window reply.
}

/**
 * Handles WhatsApp delivery and read status callbacks.
 *
 * Key fields received:
 * - `status.id`: Message ID (`wamid...`).
 * - `status.status`: `'sent' | 'delivered' | 'read' | 'failed'`.
 * - `status.recipient_id`: Customer's phone number.
 * - `status.errors`: Error details if delivery failed.
 */
export async function handleWhatsAppStatus(
  status: WhatsAppStatus,
  env: Env,
  ctx?: unknown
): Promise<void> {
  console.log(`[WhatsApp Status] Message ${status.id} status changed to: ${status.status}`);

  // TODO (Person 2 / NotificationStatusHandler):
  // Reconcile status callback with notification job table in D1.
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
              await handleWhatsAppStatus(status, env, ctx);
            }
          }
        }
      }
    }
  }

  return { status: 200, message: 'EVENT_RECEIVED' };
}
