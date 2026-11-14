CREATE TABLE distribuidoras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  google_calendar_id TEXT UNIQUE,
  calendar_view_url TEXT,
  calendar_setup_status TEXT NOT NULL DEFAULT 'pending' CHECK(calendar_setup_status IN ('pending','creating','creation_unknown','sharing','ready','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO distribuidoras (id, name, email, created_at, updated_at)
VALUES ('dwc', 'Dallas Wellness Club', 'dallaswellnessclubweb@gmail.com', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE account_credentials (
  id TEXT PRIMARY KEY,
  encrypted_payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE social_accounts (
  id TEXT PRIMARY KEY,
  distribuidora_id TEXT NOT NULL REFERENCES distribuidoras(id),
  platform TEXT NOT NULL CHECK(platform IN ('instagram','whatsapp','tiktok')),
  provider_account_id TEXT NOT NULL,
  handle TEXT,
  status TEXT NOT NULL CHECK(status IN ('connected','disconnected','needs_authorization')),
  credential_id TEXT REFERENCES account_credentials(id),
  token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform, provider_account_id)
);
CREATE INDEX idx_social_accounts_owner ON social_accounts(distribuidora_id);
CREATE TABLE gym_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE connection_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  distribuidora_id TEXT REFERENCES distribuidoras(id),
  verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
ALTER TABLE bookings ADD COLUMN distribuidora_id TEXT REFERENCES distribuidoras(id);
ALTER TABLE bookings ADD COLUMN social_account_id TEXT REFERENCES social_accounts(id);
ALTER TABLE bookings ADD COLUMN origin_channel TEXT;
ALTER TABLE bookings ADD COLUMN origin_handle TEXT;
UPDATE bookings SET distribuidora_id = 'dwc';
CREATE INDEX idx_bookings_distribuidora ON bookings(distribuidora_id, starts_at);
