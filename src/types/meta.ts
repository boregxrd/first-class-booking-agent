/**
 * ============================================================================
 * INSTAGRAM MESSAGING WEBHOOK TYPES
 * ============================================================================
 */

export interface InstagramMessageAttachment {
  type: 'image' | 'video' | 'audio' | 'story_mention' | 'share' | 'file' | 'fallback';
  payload: {
    url?: string;
    title?: string;
  };
}

export interface InstagramMessagingEvent {
  sender: {
    id: string; // Instagram-Scoped User ID (IGSID)
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
    attachments?: InstagramMessageAttachment[];
    quick_reply?: {
      payload: string; // Developer-defined payload of quick reply button
    };
  };
  reaction?: {
    mid: string;
    action: 'react' | 'unreact';
    reaction?: string;
    emoji?: string;
  };
  postback?: {
    mid?: string;
    title: string;
    payload: string;
  };
  referral?: {
    source: string;
    type: string;
    ref?: string;
    ad_id?: string;
  };
}

export interface InstagramWebhookPayload {
  object: 'instagram';
  entry: Array<{
    id: string; // Instagram Business Account ID
    time: number; // Event timestamp (ms)
    messaging?: InstagramMessagingEvent[];
  }>;
}

/**
 * ============================================================================
 * WHATSAPP CLOUD API WEBHOOK TYPES
 * ============================================================================
 */

export type WhatsAppMessageType =
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

export interface WhatsAppIncomingMessage {
  id: string; // Message ID (e.g., wamid.HB...)
  from: string; // Customer's WhatsApp phone number (no +)
  timestamp: string; // Message timestamp (seconds since epoch)
  type: WhatsAppMessageType;
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
}

export interface WhatsAppMetadata {
  display_phone_number: string;
  phone_number_id: string; // Used to send reply messages via Graph API
}

export interface WhatsAppContact {
  wa_id: string; // Customer's phone number
  profile: {
    name: string; // Display name
  };
}

export interface WhatsAppStatus {
  id: string; // Message ID
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title: string; message?: string }>;
}

export interface WhatsAppWebhookPayload {
  object: 'whatsapp_business_account';
  entry: Array<{
    id: string; // WhatsApp Business Account ID (WABA ID)
    changes: Array<{
      field: 'messages';
      value: {
        messaging_product: 'whatsapp';
        metadata: WhatsAppMetadata;
        contacts?: WhatsAppContact[];
        messages?: WhatsAppIncomingMessage[];
        statuses?: WhatsAppStatus[];
      };
    }>;
  }>;
}

export type MetaWebhookPayload =
  | InstagramWebhookPayload
  | WhatsAppWebhookPayload
  | { object: string; [key: string]: unknown };
