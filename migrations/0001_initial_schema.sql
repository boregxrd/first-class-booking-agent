-- ============================================================================
-- D1 Initial Schema Migration: First-Class Booking Agent
-- ============================================================================

-- 1. Customers & Cross-Channel Identity
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT,
  whatsapp_phone TEXT,
  language TEXT NOT NULL DEFAULT 'es',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_identities (
  channel TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, business_account_id, sender_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_identities_customer ON channel_identities(customer_id);

-- 2. WhatsApp Opt-in / Consent Evidence
CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_business_account_id TEXT NOT NULL,
  source_sender_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_consents_customer ON consents(customer_id);
CREATE INDEX IF NOT EXISTS idx_consents_phone ON consents(phone);

-- 3. Conversations & Messages
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  selected_starts_at TEXT,
  pending_proposal TEXT, -- JSON serialized pending proposal
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  provider_message_id TEXT,
  role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
  text TEXT NOT NULL,
  tool_calls TEXT, -- JSON array
  tool_results TEXT, -- JSON array
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_dedup ON messages(channel, business_account_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- 4. Processed Webhooks for Idempotent Ingestion
CREATE TABLE IF NOT EXISTS processed_webhooks (
  channel TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (channel, business_account_id, provider_message_id)
);

-- 5. Trial Bookings & Idempotent Operations
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'America/Chicago',
  status TEXT NOT NULL, -- 'pending' | 'confirmed' | 'cancelled' | 'elapsed' | 'failed'
  revision INTEGER NOT NULL DEFAULT 1,
  calendar_id TEXT,
  event_id TEXT,
  calendar_etag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_starts_at ON bookings(starts_at);

CREATE TABLE IF NOT EXISTS booking_operations (
  operation_key TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  action TEXT NOT NULL, -- 'book' | 'reschedule' | 'cancel'
  argument_fingerprint TEXT NOT NULL,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  status TEXT NOT NULL, -- 'succeeded' | 'pending' | 'failed'
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, operation_key)
);

-- 6. Notification Jobs & WhatsApp Delivery Receipts
CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  booking_revision INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL, -- 'confirmation' | 'reminder'
  scheduled_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'leased' | 'accepted' | 'unknown' | 'failed' | 'cancelled'
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  provider_message_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(booking_id, booking_revision, kind)
);

CREATE INDEX IF NOT EXISTS idx_notification_jobs_due ON notification_jobs(state, scheduled_at);

CREATE TABLE IF NOT EXISTS notification_delivery_events (
  id TEXT PRIMARY KEY,
  business_account_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  status TEXT NOT NULL, -- 'sent' | 'delivered' | 'read' | 'failed'
  occurred_at TEXT NOT NULL,
  error_code TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delivery_events_message ON notification_delivery_events(provider_message_id);
