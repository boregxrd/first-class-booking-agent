/**
 * Cloudflare Worker Environment Bindings
 */
export interface Env {
  // Environment Variables & Secrets
  META_VERIFY_TOKEN: string;
  META_APP_SECRET: string;

  // (Optional future bindings)
  META_ACCESS_TOKEN?: string;
  META_PHONE_NUMBER_ID?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;

  // Google Calendar API Bindings (Service Account)
  GOOGLE_CALENDAR_ID?: string;
  GOOGLE_CLIENT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;

  // Cloudflare D1 Database Binding
  DB?: D1Database;

  // Cloudflare Queues Binding (for asynchronous processing)
  MESSAGE_QUEUE?: Queue;
}
