/**
 * Cloudflare Worker Environment Bindings
 */
export interface Env {
  // Environment Variables & Secrets
  META_VERIFY_TOKEN: string;
  META_APP_SECRET: string;
  META_MESSAGING_MODE?: 'observe' | 'test' | 'live';
  META_TEST_INSTAGRAM_SENDER_IDS?: string;
  META_TEST_WHATSAPP_SENDER_IDS?: string;

  // (Optional future bindings)
  META_INSTAGRAM_ACCESS_TOKEN?: string;
  META_INSTAGRAM_ACCOUNT_ID?: string;
  META_INSTAGRAM_TOKEN_EXPIRES_AT?: string;
  META_WHATSAPP_ACCESS_TOKEN?: string;
  META_WHATSAPP_PHONE_NUMBER_ID?: string;
  META_WHATSAPP_TOKEN_EXPIRES_AT?: string;
  META_GRAPH_API_VERSION?: string;
  WHATSAPP_CONFIRMATION_TEMPLATE?: string;
  WHATSAPP_REMINDER_TEMPLATE?: string;
  WHATSAPP_NOTIFICATIONS_ENABLED?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  DIRECT_CHAT_TOKEN?: string;

  // Google Calendar API Bindings (Service Account)
  GOOGLE_CALENDAR_ID?: string;
  GOOGLE_CLIENT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;

  // Cloudflare D1 Database Binding
  DB?: D1Database;

  // Cloudflare Queues Binding (for asynchronous processing)
  MESSAGE_QUEUE?: Queue;
}
