import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

// ============================================================================
// ENVIRONMENT / CONFIGURATION
// ============================================================================
const PORT = Number(process.env.PORT) || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;

const app = new Hono();

// ============================================================================
// TYPES & DATA CONTRACTS
// ============================================================================

/**
 * 1. INSTAGRAM MESSAGING PAYLOAD
 * Arrives under `entry[].messaging[]` when `object === 'instagram'`
 */
export interface InstagramWebhookPayload {
  object: 'instagram';
  entry: Array<{
    id: string; // Instagram Business Account ID (IGBID)
    time: number; // Event timestamp (ms)
    messaging?: Array<{
      sender: {
        id: string; // Instagram-Scoped User ID (IGSID) of the sender
      };
      recipient: {
        id: string; // Instagram Business Account ID
      };
      timestamp: number; // Message timestamp (ms)
      message?: {
        mid: string; // Unique Message ID
        text?: string; // Text content
        is_echo?: boolean; // true if message was sent by your own business account
        reply_to?: {
          mid: string; // ID of the referenced/replied message
        };
        attachments?: Array<{
          type: 'image' | 'video' | 'audio' | 'story_mention' | 'share' | 'file' | 'fallback';
          payload: {
            url?: string; // Media CDN URL (may be temporary or authenticated)
            title?: string;
          };
        }>;
        quick_reply?: {
          payload: string; // Developer-defined payload of quick reply button
        };
      };
      reaction?: {
        mid: string; // Message ID being reacted to
        action: 'react' | 'unreact';
        reaction?: string; // Emoji character or empty
        emoji?: string;
      };
      postback?: {
        mid?: string;
        title: string;
        payload: string;
      };
      referral?: {
        source: string; // e.g. "ADS"
        type: string; // e.g. "OPEN_THREAD"
        ref?: string;
        ad_id?: string;
      };
    }>;
  }>;
}

/**
 * 2. WHATSAPP CLOUD API PAYLOAD
 * Arrives under `entry[].changes[]` when `object === 'whatsapp_business_account'`
 */
export interface WhatsAppWebhookPayload {
  object: 'whatsapp_business_account';
  entry: Array<{
    id: string; // WhatsApp Business Account ID (WABA ID)
    changes: Array<{
      field: 'messages';
      value: {
        messaging_product: 'whatsapp';
        metadata: {
          display_phone_number: string; // Business phone number
          phone_number_id: string; // Phone number ID (used to send replies via API)
        };
        contacts?: Array<{
          wa_id: string; // Customer's WhatsApp phone number (no + sign)
          profile: {
            name: string; // Customer's WhatsApp profile name
          };
        }>;
        messages?: Array<{
          id: string; // Message ID (e.g., wamid.HB...)
          from: string; // Customer's WhatsApp phone number
          timestamp: string; // Message timestamp (seconds since epoch)
          type:
            | 'text'
            | 'image'
            | 'audio'
            | 'video'
            | 'document'
            | 'sticker'
            | 'location'
            | 'contacts'
            | 'interactive'
            | 'button'
            | 'reaction';
          context?: {
            id: string; // ID of the message being replied to
            from: string; // Sender of the original message
          };
          text?: {
            body: string; // Text content
          };
          image?: { id: string; mime_type: string; sha256: string; caption?: string };
          audio?: { id: string; mime_type: string; sha256: string; voice?: boolean };
          video?: { id: string; mime_type: string; sha256: string; caption?: string };
          document?: { id: string; mime_type: string; sha256: string; filename?: string };
          interactive?: {
            type: 'button_reply' | 'list_reply';
            button_reply?: { id: string; title: string };
            list_reply?: { id: string; title: string; description?: string };
          };
          location?: {
            latitude: number;
            longitude: number;
            name?: string;
            address?: string;
          };
          reaction?: {
            message_id: string;
            emoji: string;
          };
        }>;
        statuses?: Array<{
          id: string; // Message ID for which status changed
          status: 'sent' | 'delivered' | 'read' | 'failed';
          timestamp: string;
          recipient_id: string;
          errors?: Array<{ code: number; title: string; message?: string }>;
        }>;
      };
    }>;
  }>;
}

export type MetaWebhookPayload = InstagramWebhookPayload | WhatsAppWebhookPayload | { object: string; [key: string]: any };

// ============================================================================
// SIGNATURE VERIFICATION HELPER (HMAC-SHA256)
// ============================================================================
async function verifyMetaSignature(rawBody: string, signatureHeader?: string): Promise<boolean> {
  if (!APP_SECRET) return true; // Skip if no secret is configured yet
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = signatureHeader.slice(7); // remove "sha256="
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(APP_SECRET),
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
// HEALTH CHECK
// ============================================================================
app.get('/', (c) => c.text('Meta Webhook Server is running! 🚀'));

// ============================================================================
// 1. WEBHOOK AUTHENTICATION & SUBSCRIPTION CHALLENGE (GET /webhook)
// ============================================================================
app.get('/webhook', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log('[Webhook] Verification challenge succeeded!');
    // Meta requires the challenge string returned with status 200
    return c.text(challenge, 200);
  }

  console.warn('[Webhook] Verification challenge failed. Check your META_VERIFY_TOKEN.');
  return c.text('Forbidden', 403);
});

// ============================================================================
// 2. WEBHOOK EVENT HANDLER (POST /webhook)
// ============================================================================
app.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('x-hub-signature-256');

  // Verify HMAC-SHA256 signature to guarantee request authenticity
  if (APP_SECRET && APP_SECRET !== 'your_meta_app_secret_here') {
    const isValid = await verifyMetaSignature(rawBody, signature);
    if (!isValid) {
      console.warn('[Webhook] Invalid payload signature received.');
      return c.text('Unauthorized: Invalid Signature', 401);
    }
  }

  let body: MetaWebhookPayload;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.text('Invalid JSON', 400);
  }

  // Handle Instagram Webhook Events
  if (body.object === 'instagram') {
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (event.message) {
          handleInstagramMessage(event);
        }
      }
    }
  }

  // Handle WhatsApp Cloud API Webhook Events
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'messages' && change.value) {
          const { metadata, contacts, messages, statuses } = change.value;

          if (messages && messages.length > 0) {
            for (const message of messages) {
              handleWhatsAppMessage(message, metadata, contacts);
            }
          }

          if (statuses && statuses.length > 0) {
            for (const status of statuses) {
              handleWhatsAppStatus(status);
            }
          }
        }
      }
    }
  }

  // Always acknowledge Meta with 200 OK promptly to prevent retries
  return c.text('EVENT_RECEIVED', 200);
});

// ============================================================================
// 3. EVENT HANDLERS (STUBS)
// ============================================================================

/**
 * Handle incoming Instagram DM events
 */
function handleInstagramMessage(
  event: NonNullable<NonNullable<InstagramWebhookPayload['entry'][0]['messaging']>[0]>
) {
  const senderId = event.sender.id;
  const messageText = event.message?.text;
  console.log(`[Instagram] Message from ${senderId}: ${messageText ?? '[Attachment/Other]'}`);
  // [Your custom business logic here]
}

/**
 * Handle incoming WhatsApp messages
 */
function handleWhatsAppMessage(
  message: NonNullable<WhatsAppWebhookPayload['entry'][0]['changes'][0]['value']['messages']>[0],
  metadata: WhatsAppWebhookPayload['entry'][0]['changes'][0]['value']['metadata'],
  contacts?: WhatsAppWebhookPayload['entry'][0]['changes'][0]['value']['contacts']
) {
  const fromNumber = message.from;
  const senderName = contacts?.[0]?.profile?.name || 'Customer';
  const textBody = message.text?.body;
  console.log(`[WhatsApp] Message from ${senderName} (${fromNumber}): ${textBody ?? `[${message.type}]`}`);
  // [Your custom business logic here]
}

/**
 * Handle WhatsApp delivery & read receipts
 */
function handleWhatsAppStatus(
  status: NonNullable<WhatsAppWebhookPayload['entry'][0]['changes'][0]['value']['statuses']>[0]
) {
  console.log(`[WhatsApp] Status update for message ${status.id}: ${status.status}`);
  // [Your status tracking logic here]
}

// ============================================================================
// START SERVER
// ============================================================================
serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`🚀 Meta Webhook Server running at http://localhost:${info.port}`);
    console.log(`📡 Webhook endpoint: http://localhost:${info.port}/webhook`);
  }
);

export default app;
