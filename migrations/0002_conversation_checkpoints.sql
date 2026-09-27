-- Part A owns conversation checkpoints and processed-turn replay.
-- Keep the original shared migration intact; apply both migrations in order.
ALTER TABLE conversations ADD COLUMN booking_operation TEXT;

CREATE TABLE processed_turns (
  channel TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (channel, business_account_id, provider_message_id)
);
