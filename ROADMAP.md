# First-class booking agent — implementation roadmap

## Scope and decisions

Follow the **final** decisions in `context.md:468–536`; earlier capacity/Airtable proposals are superseded.

- Book new prospects into a free trial entirely inside Instagram/WhatsApp chat.
- Unlimited attendees. Validate scheduled class times and closures; no seat inventory.
- Google Calendar is the owner's schedule: **one event per prospect's booking**.
- Keep durable application state in D1 (proposed): conversations, identity, booking/event mapping, webhook deduplication, and notification jobs.
- Gymdesk remains separate. The bot cannot infer membership purchases or actual attendance.
- Target less than $100/month at fewer than 500 prospects; measure tokens/messages and verify vendor pricing before launch.
- Proposed deployment: Cloudflare Workers + D1 + Queues + a scheduled handler. The current app is Node/Hono, so this is still migration work.

## Current audit

Checked against `index.ts`, `package.json`, `tsconfig.json`, and `.env.example`. A checked box below means code exists, **not** that an external integration is deployed or verified live.

| Capability | Current evidence | Status |
| --- | --- | --- |
| Node/Hono server and health endpoint | `index.ts:183,308–319` | Implemented |
| Meta verification challenge | `index.ts:188–201` | Implemented; configuration guard needed |
| HMAC-SHA256 verification | `index.ts:156–178,210–217` | Partial; missing/placeholder secret bypasses verification |
| Instagram inbound event routing | `index.ts:226–235,271–278` | Logs messages only |
| WhatsApp inbound/status routing | `index.ts:237–258,283–303` | Logs messages/statuses only |
| Payload types | `index.ts:22–151` | Compile-time only; fallback `any` weakens narrowing |
| LLM, tool execution, outbound replies | No implementation/dependencies | Missing |
| Conversation/customer persistence, queue, deduplication | No implementation | Missing |
| Calendar bookings, changes/cancellations | No implementation | Missing |
| WhatsApp templates, reminder scheduler | No implementation | Missing |
| Workers/D1 deployment, migrations, automated tests | No configuration/scripts | Missing |

Specific gaps to address: missing verify token can match an omitted query token; JSON is parsed without structural validation; Instagram echoes are not filtered; no durable handoff before acknowledgement; WhatsApp contact lookup uses the first contact rather than matching `wa_id`; raw message text and phone numbers are logged. `serve()` runs on import, making isolated handler tests awkward.

## How a message executes

```text
Meta POST /webhook
  -> validate signature + payload
  -> await durable queue publication
  -> return 200 to Meta (publication failure must remain retryable)

Queue consumer
  -> deduplicate / serialize processing for this conversation
  -> load recent history + structured state
  -> await LLM response
  -> if tool requested: validate args, await BookingService, give result to LLM
  -> repeat within a bounded tool-call budget
  -> persist result and send reply via Meta API

Scheduled handler
  -> reconcile tracked Calendar events
  -> claim due notification jobs
  -> recheck booking/event version and consent
  -> send approved WhatsApp template and track status callbacks
```

Yes, the LLM client returns a Promise and the consumer awaits it. The customer receives a **separate outbound Meta API message**, not the HTTP webhook response. An unawaited Promise is not a durable background job. Queues may redeliver and do not by themselves guarantee conversation ordering or exactly-once external sends.

## Shared contract and collaboration

Use `model.ts` for provider-independent domain types and service interfaces; keep Meta wire payloads in A's adapter. TypeScript types are not runtime validation or SQL schemas: those are separate tasks below.

- [x] Define initial shared TypeScript models and BookingService/notification interfaces in `model.ts`.
- [ ] Review the contract together before implementing adapters; model types are not wired into the current server yet.

The integration boundary is `BookingService`: `getClassSchedule`, `getBooking`, `bookTrial`, `rescheduleTrial`, `cancelTrial`. A supplies a trusted customer context; model-generated tool arguments never supply customer identity, consent evidence, or idempotency keys. B validates schedule/ownership and handles persistence/Calendar side effects. Confirmation is allowed only after the service reports successful Calendar creation.

`WhatsAppTemplateSender` is the reverse boundary: A implements the channel API adapter; B uses it to deliver persisted confirmation/reminder jobs. Delivery receipts return to B's `NotificationStatusHandler`.

- A can test with a fake BookingService while B builds Calendar integration.
- B can test with a fake WhatsAppTemplateSender while A builds Meta sending.
- Suggested folders below are planned, not already implemented. Keep each person's changes in their owned folders; coordinate edits to `model.ts`.
- A owns runtime setup, `package.json`, worker entrypoint, deployment config, conversation migrations. B owns booking/notification migrations. Prefix migration filenames with distinct ordered numbers and agree their order before merge.

### Proposed persistence schema

| Owner | Table | Important fields/constraints |
| --- | --- | --- |
| A | `customers` | ID, name, normalized phone, language, timestamps; do not automatically merge people by entered phone |
| A | `channel_identities` | Customer FK; unique `(channel, business_account_id, sender_id)` |
| A | `consents` | Customer FK, phone, purpose, grant/revoke timestamps and source message/identity |
| A | `conversations` | Customer/identity FK, selected start time, revision |
| A | `messages` | Conversation FK, role/direction, text or structured tool turn, provider ID, processing/send state; unique inbound channel/account/message key |
| B | `bookings` | Customer FK, UTC start/end, status, revision, Calendar ID/event ID/etag; partial unique customer index for pending/confirmed bookings (transition past confirmed bookings to elapsed explicitly) |
| B | `booking_operations` | Unique `(customer_id, operation_key)`, action, argument fingerprint, booking FK, desired change, processing state/result; preserves pending reschedules without overwriting confirmed times |
| B | `notification_jobs` | Booking FK, revision, kind, scheduled time, lease, attempts, send state/provider ID; unique `(booking_id, booking_revision, kind)` |
| B | `notification_delivery_events` | Provider message ID, status, timestamp, error; retain early callbacks that arrive before the send result is persisted |

The schedule can start as version-controlled configuration rather than a class/session table. Persist tool-call/result history so interrupted turns can recover. The elapsed transition must run before testing eligibility for a new booking; it is not proof the customer attended or permission for a second trial. SQL migrations, indexes, runtime validators and repository functions are still implementation work.

## Part A — Messaging, conversation agent, and runtime (Person 1)

**Owns:** `index.ts`, future `src/channels/`, `src/agent/`, `src/conversations/`, runtime configuration and conversation storage.

### A1. Inbound messaging and infrastructure

- [x] Scaffold TypeScript + Hono + Node development server.
- [x] Implement health endpoint and Meta verification challenge handler.
- [x] Route Instagram and WhatsApp messages/statuses to handlers.
- [x] Add basic signature verification and environment examples.
- [ ] Split app construction from server startup so handlers can be tested without opening a port.
- [ ] Migrate entrypoint/environment access to Workers; configure D1, queue producer/consumer, retry/dead-letter handling, and scheduled entrypoint for B.
- [ ] Require real production secrets/verify token; make any local bypass explicit. Use a suitable signature verification primitive and validate incoming JSON at runtime.
- [ ] Normalize supported text messages into the shared inbound model; filter echoes, own-account messages, receipts and unsupported event types. Match WhatsApp contacts by sender.
- [ ] Durably enqueue before acknowledging; deduplicate with channel + business account + provider message ID.
- [ ] Add per-conversation serialization with crash recovery. Do not assume queue delivery is ordered.
- [ ] Add structured logs and correlation IDs without dumping customer phone numbers/message bodies by default.

### A2. Agent and channel output

- [ ] Choose a tool-calling provider/model; add credentials, request timeout, bounded retries, usage measurement, and turn/tool-call limits.
- [ ] Persist customer/channel identity, conversation state and recent history. Keep phone consent evidence tied to the inbound message that granted it.
- [ ] Define safe cross-channel identity linking: an Instagram-entered phone number alone must not authorize access to another person's existing booking.
- [ ] Supply approved gym facts, current time and `America/Chicago` timezone to the prompt. Use natural Spanish/English replies, collect required details, and confirm the customer's booking intent.
- [ ] Implement runtime-validated tools using BookingService; inject trusted customer identity, consent and stable operation keys from application state.
- [ ] Implement the await-model → execute-tools → await-model loop; only claim booking success after B returns success.
- [ ] Implement Instagram replies and WhatsApp in-window text replies using the configured Meta API route/version and appropriate credentials.
- [ ] Implement WhatsAppTemplateSender for approved templates; return provider message IDs and distinguish definite rejection from unknown delivery outcome.
- [ ] Route delivery callbacks to B's NotificationStatusHandler; honor messaging windows and opt-out events.
- [ ] Persist outgoing-send state; handle retries without blindly resending after ambiguous timeouts.

### A3. Verification and rollout

- [ ] Test challenge/signature validation, malformed payloads, batched events, echo filtering, duplicate delivery and queue failures.
- [ ] Test multi-message ordering, model timeout, invalid tool arguments, repeated tool calls, unsupported media and send failures.
- [ ] Run a local scripted conversation against B's fake service, then the real service.
- [ ] Configure Meta permissions/subscriptions and prove an Instagram DM → real model → Instagram reply round trip.
- [ ] Own deployment/runbook, secret setup, queue/error monitoring and end-to-end release check with Person 2.

**Done when:** a real chat can answer approved questions and invoke B's booking actions with persistent context, safe retries and working outbound replies.

## Part B — Trial bookings, Google Calendar, and reminders (Person 2)

**Owns:** future `src/bookings/`, `src/calendar/`, `src/notifications/`, `src/gym/`, and booking/notification SQL migrations.

### B1. Schedule and booking service

- [ ] Turn owner-approved weekly times, duration, closures and booking horizon into configuration; validate chosen local times deterministically.
- [ ] Implement BookingService against the shared contract; use UTC instants for storage and Dallas timezone for schedule rules/display.
- [ ] Add D1 migrations/repositories for bookings, operation idempotency and notification jobs, referencing A's customer records.
- [ ] Enforce one active trial booking per customer and stable operation keys; define how cancelled/past trials can be rebooked with the owner.
- [ ] Support create, get, reschedule and cancel scoped to the trusted customer; model pending/sync failure states explicitly.
- [ ] Make DB-to-Calendar operations recoverable across timeouts/crashes; a SQL transaction cannot atomically commit a Google API request.

### B2. Google Calendar

- [ ] Create a dedicated trial calendar and configure API authorization (service account with calendar access or owner OAuth refresh credentials).
- [ ] Create one event per booking: name, time, address and approved prospect details; record Calendar event ID in D1.
- [ ] Derive a Calendar-compatible deterministic event ID from the persisted booking ID and reconcile conflicts/timeouts before retrying creation.
- [ ] Implement event updates/cancellation with revision/concurrency handling. Never lose the old booking just because an update failed.
- [ ] Reconcile owner edits/deletions into D1. Scan tracked upcoming events, not only jobs already due, so earlier calendar moves are detected.
- [ ] Recompute/invalidate notification jobs on changes; handle deleted/cancelled events and Calendar failures without sending stale reminders.

### B3. Confirmations and reminders

- [ ] Agree reminder timing and last-minute booking behavior; approve the actual Spanish/English template text with the owner.
- [ ] Submit/configure utility templates in Meta; give template names, language codes and parameter order to A.
- [ ] Create persisted confirmation/reminder jobs only for confirmed bookings with applicable WhatsApp consent.
- [ ] Add an atomic claim/lease, retry/backoff and unique booking + revision + notification-kind key; scheduler calls A's WhatsAppTemplateSender.
- [ ] Recheck current Calendar state and consent before dispatch. Booking success remains independent of a later notification failure.
- [ ] Persist provider message IDs and delivery/read/failure callbacks through NotificationStatusHandler; avoid status regression from out-of-order callbacks.
- [ ] Handle ambiguous send outcomes explicitly; do not claim exactly-once WhatsApp delivery or blindly retry unknown outcomes.

### B4. Verification and rollout

- [ ] Test schedule validation, DST/date boundaries, duplicate booking operations and cross-customer ownership checks.
- [ ] Test Calendar timeout-after-create, failed reschedule, direct owner changes/deletion and DB failure after Calendar success.
- [ ] Test concurrent reminder claims, reschedules/cancellations, last-minute bookings, consent withdrawal and delivery failures.
- [ ] Prove real booking → Calendar event → WhatsApp confirmation → scheduled reminder with Person 1.
- [ ] Owner verifies the calendar on their phone and confirms the event details are useful.

**Done when:** a booking is visible in Calendar, changes recover reliably, and confirmations/reminders reflect the current booking and consent.

## Build order and decisions needed

1. Agree shared types and runtime choice; A sets up runtime/conversation storage while B builds schedule/Calendar against fakes.
2. Integrate the first vertical slice: Instagram text → agent → bookTrial → Calendar → Instagram confirmation.
3. Wire WhatsApp confirmation/reminders and change/cancel flows.
4. Exercise retries and owner Calendar edits, then run the live acceptance flow together.

Owner inputs still needed: actual class duration, confirmed weekly times/closures, FAQ/prices/what-to-bring, eligibility/rebooking rules, reminder timing and minimum booking lead time. Developer choices: model/provider, Calendar auth method, supported languages, and cross-channel verification/linking flow.

## Validation log

- Baseline `npx tsc --noEmit`: passed during this audit.
- `npx tsc --noEmit` with shared models: passed.
- Local HTTP smoke checks: health, challenge acceptance/rejection, unsigned request rejection with a configured secret, malformed JSON rejection, signed Instagram/WhatsApp message routing and WhatsApp status logging passed.
- Confirmed structural-validation gap: a signed JSON `null` payload returns HTTP 500. Fix and regression coverage are assigned to A1/A3.
- External Meta, Google Calendar and LLM connectivity: not verified by this audit.
