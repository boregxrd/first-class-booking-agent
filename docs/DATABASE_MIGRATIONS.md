# Database migrations

These SQL files are applied in numeric order to the Cloudflare D1 database configured in `wrangler.jsonc`. They create the initial schema and then evolve it; later migrations assume earlier ones have already run.

## `0001_initial_schema.sql` — initial schema

### Customers and channel identity

- **`customers`** stores a person known to the booking agent: their internal ID, optional name and WhatsApp phone, language (defaults to Spanish), and creation/update timestamps.
- **`channel_identities`** maps a sender identity on a specific channel and business account to a customer. Its composite primary key is `(channel, business_account_id, sender_id)`, so the same sender ID can be distinct across channels or accounts. Deleting a customer deletes their identities. An index on `customer_id` supports looking up a customer's identities.

### Consent

- **`consents`** stores evidence of a customer's opt-in, including phone, purpose, grant time, source channel/account/sender/message, and an optional revocation time. It references `customers` and is deleted with the customer. Indexes on `customer_id` and `phone` support consent lookups.

### Conversations and messages

- **`conversations`** stores a customer's conversation on a channel/account/sender, along with an optional selected booking start time, serialized pending proposal, revision number (defaults to `1`), and update time. It references `customers` and is deleted with the customer. An index on `customer_id` supports finding a customer's conversations.
- **`messages`** stores conversation history: channel identity, optional provider message ID, role (`user`, `assistant`, or `system`), text, optional serialized tool calls/results, and creation time. It references `conversations` and is deleted with the conversation. An index on `(conversation_id, created_at)` supports ordered history retrieval. A partial unique index on `(channel, business_account_id, provider_message_id)` prevents duplicate stored messages when a provider message ID is present.

### Webhook deduplication

- **`processed_webhooks`** records provider messages already ingested, keyed by `(channel, business_account_id, provider_message_id)`. The primary key supports idempotent webhook processing.

### Bookings and booking operations

- **`bookings`** stores trial booking details: customer, start/end times, time zone (defaults to `America/Chicago`), status, revision, optional calendar/event IDs and calendar ETag, and timestamps. It references `customers` and is deleted with the customer. Indexes on customer, status, and start time support booking lookups and scheduling.
- **`booking_operations`** records booking actions (`book`, `reschedule`, or `cancel`) and their idempotency key, argument fingerprint, optional booking, status, serialized result, and timestamps. Its primary key is `(customer_id, operation_key)`; it references the customer and optionally a booking. Deleting a booking sets `booking_id` to null.

### Notifications

- **`notification_jobs`** stores scheduled booking messages such as confirmations and reminders. It tracks the booking revision and kind, scheduled time, delivery state (defaults to `pending`), retry count, optional lease/provider message/error details, and timestamps. A unique constraint on `(booking_id, booking_revision, kind)` avoids duplicate jobs for the same booking revision and notification kind. Jobs are deleted with their booking. An index on `(state, scheduled_at)` supports finding due jobs.
- **`notification_delivery_events`** stores provider delivery receipts (`sent`, `delivered`, `read`, or `failed`), including provider message ID, occurrence/receipt times, business account, and optional error code. An index on `provider_message_id` supports matching receipts to messages.

## `0002_conversation_checkpoints.sql` — processed-turn replay

- **`conversations`** gains nullable `booking_operation`, for serialized booking-operation state associated with a conversation.
- **`processed_turns`** is created to store the result of processing an inbound provider message, keyed by `(channel, business_account_id, provider_message_id)`. It records the conversation, serialized result, and processing time. It references `conversations` and is deleted with the conversation. The key lets a repeated turn return its prior result instead of being processed again.

## `0003_shared_slot_rosters.sql` — booking and slot coordination

- **`customers`** gains nullable `instagram_handle`.
- **`booking_operations`** gains nullable `affected_slots` (serialized affected slots), `lease_token`, and `lease_expires_at`, supporting coordination and leasing of pending operations.
- **`bookings`** gains a partial unique index on `customer_id` for rows whose status is `pending` or `confirmed`, enforcing at most one active trial booking per customer. It also gains an index on `(calendar_id, starts_at, status)` for slot roster lookups. The unique index intentionally causes the migration to fail if existing data already contains duplicate active bookings; it does not silently choose one.
- **`booking_operations`** gains a partial unique index on `customer_id` for rows whose status is `pending`, enforcing at most one pending booking operation per customer.

## `0004_durable_messaging.sql` — durable message delivery and operations

### New tables

- **`message_inbox`** is a durable inbound-message queue. Each row stores the channel and sender identity, provider message ID, serialized payload, send/creation times, processing state (defaults to `pending`), attempt count, next available time, and optional last error. An auto-incrementing `seq` orders messages. A unique constraint on `(channel, business_account_id, provider_message_id)` deduplicates inbound messages. Indexes support scanning available work in sequence and finding a sender's messages.
- **`processing_leases`** stores a lease ID, token, and expiry for coordinating message processing.
- **`outgoing_messages`** is a durable outbound-message queue. It stores the conversation and recipient identity, source inbound message, text, last inbound time, state (defaults to `pending`), retry/availability data, optional lease and provider message IDs, error and timestamps. It references `conversations`. A unique constraint on `(channel, business_account_id, source_message_id)` prevents creating multiple outgoing replies for the same source message. An index on `(state, available_at)` supports due-message processing. Later in this migration it gains nullable `delivery_status` and `delivery_at`.
- **`operational_alerts`** stores operational issues by kind and resource, with details, state (defaults to `open`), and timestamps.
- **`calendar_slot_health`** stores the last known health state and optional reason for a calendar event at a slot, keyed by `(calendar_id, starts_at)`, with a check time.
- **`identity_link_codes`** stores a hashed identity-link code, its customer and phone, expiry, and optional use time. It references `customers`.

### Changes to existing tables

- **`conversations`** gains a unique index on `(channel, business_account_id, sender_id)`, enforcing one conversation per channel/account/sender identity.
- **`outgoing_messages`** gains nullable `delivery_status` and `delivery_at` fields to record delivery-receipt information.
- **`notification_jobs`** gains nullable `available_at`, `business_account_id`, `delivery_status`, and `delivery_at` fields for retry scheduling, account context, and delivery tracking.
- **`notification_delivery_events`** gains a unique index on `(business_account_id, provider_message_id, status, occurred_at)` to deduplicate receipts, plus nullable `correlation_id` and `reconciled_at` fields for correlating and tracking receipt reconciliation.
- **`conversations.pending_proposal`** and **`conversations.booking_operation`** are updated for existing rows: when their JSON value is present and has no `action`, the migration sets `action` to `"book"`. Rows with a null value or an existing action are left unchanged.

## `0005_instagram_profile.sql` — Instagram profile suggestions

- **`conversations`** gains nullable `instagram_profile` JSON: the account-scoped sender's display name/username, lookup timestamp, and any outstanding name-confirmation question and expiry. Profile names remain separate from `customers.name`; they are not accepted as booking names without the person's confirmation or explicit declaration.
- Successful profile reads are cached for 24 hours; unavailable profiles are retried after an hour. The automatically resolved username is stored in `customers.instagram_handle`. If Meta does not return a profile, the persisted Instagram channel identity still provides a contact channel.
- Apply this migration before deploying code that reads the new column. Older code tolerates the additional nullable column.

## `0006_booking_intake.sql` — explicit booking details

- **`conversations`** gains nullable `booking_intake` JSON for the customer-selected Dallas date/hour, supplied international phone, explicit lack of phone/WhatsApp, and last update time. Only incoming customer text updates these selections; an assistant suggestion cannot supply a missing day.
- New trial proposals must match the selected day/hour, have a customer-provided/confirmed name, and have a supplied/saved phone. Only explicit phone unavailability plus a known Instagram handle allows a phone-less proposal. A bare “sí/yes” confirms only the latest saved, unexpired summary; corrections invalidate it.
- Apply this additive migration before the updated Worker. Older pending trial summaries without verified intake must be recreated before they can be confirmed.

## `0007_distribuidoras.sql` — trainer attribution and connected accounts

- Creates minimal `distribuidoras` records with inline calendar setup state and seeds Dallas Wellness Club as a normal record. No kind/position/tier table.
- Creates `social_accounts`, separately encrypted `account_credentials`, non-secret `gym_settings`, and expiring single-use `connection_states`.
- Adds immutable-at-booking attribution fields to `bookings` and backfills existing bookings to `dwc`. Calendar IDs already stored on bookings remain unchanged.
- Apply before deploying the new booking writes, even while `MULTI_ACCOUNT_ENABLED=false`. The owner-triggered bootstrap attaches the configured general calendar and imports credentials; migration SQL never contains live tokens or encryption keys. See `OWNER_PORTAL.md` for activation and recovery.

## `0008_connection_invitation_emails.sql` — Gmail onboarding invitations

- Adds retry-safe invitation email records with recipient/profile binding, hashed private link token, encrypted secret reference, 24-hour expiry, Gmail acceptance/rejection/unknown state, provider message ID and one-use connection-start timestamp.
- Read-only email previews do not consume links; the recipient's explicit POST starts a fresh 15-minute OAuth state. The invitation is not an owner portal credential.
- Apply before the updated owner overview, invitation routes and connection-maintenance job, including when multi-account routing is off. No email is sent by the migration.
