CREATE TABLE connection_invitation_emails (
  id TEXT PRIMARY KEY,
  distribuidora_id TEXT NOT NULL REFERENCES distribuidoras(id),
  recipient TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  secret_id TEXT NOT NULL REFERENCES account_credentials(id),
  state TEXT NOT NULL CHECK(state IN ('sending','accepted','rejected','unknown')),
  provider_message_id TEXT,
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_connection_email_profile ON connection_invitation_emails(distribuidora_id, created_at);
