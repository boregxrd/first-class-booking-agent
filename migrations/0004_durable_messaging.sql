CREATE TABLE message_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE(channel, business_account_id, provider_message_id)
);
CREATE INDEX idx_inbox_pending ON message_inbox(state, available_at, seq);
CREATE INDEX idx_inbox_conversation ON message_inbox(channel, business_account_id, sender_id, seq);

CREATE TABLE processing_leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE UNIQUE INDEX idx_conversation_identity ON conversations(channel, business_account_id, sender_id);

CREATE TABLE outgoing_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  channel TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  last_inbound_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  provider_message_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel, business_account_id, source_message_id)
);
CREATE INDEX idx_outgoing_due ON outgoing_messages(state, available_at);
ALTER TABLE outgoing_messages ADD COLUMN delivery_status TEXT;
ALTER TABLE outgoing_messages ADD COLUMN delivery_at TEXT;

ALTER TABLE notification_jobs ADD COLUMN available_at TEXT;
ALTER TABLE notification_jobs ADD COLUMN business_account_id TEXT;
ALTER TABLE notification_jobs ADD COLUMN delivery_status TEXT;
ALTER TABLE notification_jobs ADD COLUMN delivery_at TEXT;
CREATE UNIQUE INDEX idx_delivery_event_dedup ON notification_delivery_events(business_account_id, provider_message_id, status, occurred_at);
ALTER TABLE notification_delivery_events ADD COLUMN correlation_id TEXT;
ALTER TABLE notification_delivery_events ADD COLUMN reconciled_at TEXT;

CREATE TABLE operational_alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE calendar_slot_health (
  calendar_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  event_id TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(calendar_id, starts_at)
);
CREATE TABLE identity_link_codes (
  code_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  phone TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

UPDATE conversations SET pending_proposal = json_set(pending_proposal, '$.action', 'book')
  WHERE pending_proposal IS NOT NULL AND json_extract(pending_proposal, '$.action') IS NULL;
UPDATE conversations SET booking_operation = json_set(booking_operation, '$.action', 'book')
  WHERE booking_operation IS NOT NULL AND json_extract(booking_operation, '$.action') IS NULL;
