# Integration review after `6bcfc7b`

## Verdict

The MVP's main components are implemented, but it is not yet a reliable live booking service. The initial 22 tests passed despite the Calendar insert bug and missing persistence semantics. After the bounded fixes below, type checking and 24 tests pass, including local D1. Live Google/Meta/OpenAI calls were not made.

## Fixed in this review

- `src/calendar/client.ts`: use Google Calendar's actual insert endpoint, POST `/events`, with deterministic ID; reconcile a matching existing event after HTTP 409. Previous PUT `/events/{id}` updates an existing event and is not an insert/upsert.
- `src/bookings/service.ts`: do not confirm without Calendar configuration or required customer details; persist the configured calendar ID rather than `primary`; reject a create-operation key reused with different arguments; check cancellation revision and report deletion failure. These do not solve cross-system atomicity.
- `src/llm-integration/conversations/d1-store.ts`: fetch the latest 20 messages in chronological order; save/load booking-operation checkpoints and consent; use a separate `processed_turns` table rather than overloading B's booking operations.
- `src/runtime/factory.ts`: remove per-request MemoryStore and mock successful bookings from the runtime; lazily construct the model processor so receipts/cron do not need OpenAI credentials.
- `src/llm-integration/agent/tools.ts`: delegate schedule validation to `src/gym/schedule.ts`; reject second/millisecond offsets and invalid current timestamps in the shared validator.
- `src/llm-integration/runtime/test-access.ts`: observe by default, test allowlist by exact sender ID. This gate covers incoming conversation processing; it is not a notification scheduler allowlist. Do not enable notification sending during observation tests.
- Preserved the friend's D1/cron configuration when resolving the local verification-token config conflict. The verification token belongs in a secret, not a checked-in placeholder.

## Remaining high-priority findings

### B: create recovery and concurrency — `src/bookings/service.ts`, initial schema

`bookTrial` generates a random booking ID and calls Google before persisting the operation. If Google succeeds and the request/DB write fails, the next attempt derives a different event ID and may create another event. The deterministic hash in the client only helps if its input booking ID is stable. Concurrent creates can both pass the active-booking SELECT; there is no partial unique active-customer index.

**Next:** persist pending booking/operation first, enforce uniqueness, retry/reconcile the same event ID, and test timeout-after-create plus DB-write failure and concurrent requests.

### B: reschedule/cancel recovery — `src/bookings/service.ts`

Neither mutation replays completed operations before acting. Revision checking is separate from the SQL write, and update predicates lack expected revision. A successful Google update/delete followed by a failed DB batch leaves the systems inconsistent. Current checks are useful but not atomic recovery.

**Next:** operation replay/fingerprint checks, compare-and-swap/claims, durable desired changes and reconciliation. Test retries, competing changes and failed DB commits after Google success.

### A: conversation store does not serialize — `d1-store.ts`

`withConversation` is currently a name, not a lock. Parallel messages can create identities/conversations concurrently or overwrite checkpoints. The new checkpoint persistence fixes sequential recovery, not concurrent-turn safety. `complete` also lacks a durable outbound-send record.

**Next:** per-conversation serialization, safe first-contact creation, outbound outbox and recovery tests. The interface contract requires these before public use.

### A: synchronous webhooks and unreliable sends — `src/channels/meta.ts`, `outbound.ts`

In test/live mode, incoming handlers await the entire LLM turn inside the webhook. Caught processing errors and ignored outbound failure results can still produce HTTP 200. Replayed results can be sent twice. The default queue handler remains unconfigured and Wrangler has no queue binding. Structural payload validation is incomplete.

Instagram sending currently uses `graph.facebook.com/v21.0/me/messages` and a shared token. Our selected Instagram Login route needs its corresponding Instagram endpoint, account ID and token family; WhatsApp credentials must be separate. The template sender fabricates `wamid_accepted` when a successful response omits a message ID.

**Next:** durable ingest → queue → serialized processor → outbox dispatch; per-provider auth/config, timeouts and explicit ambiguous-send outcomes. Do not turn on public traffic merely by supplying credentials.

### B: scheduler doesn't enforce its documented checks — `src/notifications/scheduler.ts`

It queries no consent records, doesn't compare booking revisions, doesn't re-fetch Calendar state, and checks booking status from a pre-lease snapshot. Expired leases aren't reclaimed. Old/late reminders and concurrent cancellations can send incorrect messages. Language selection can be English while date text is Spanish. Delivery failures can overwrite interpretation of later receipts.

**Next:** consent/current booking/Calendar verification, recovery and concurrency tests before enabling template sends.

## Redundancy and design choices

- Removed the duplicate production memory/mock service path and duplicated schedule validator.
- `slot-roster.ts` is unused by the booking service. It implements one event per class, whereas BookingService uses one event per prospect. It also derives different keys for lookup versus creation and rewrites shared descriptions without etag concurrency control. It was retained for discussion with its author rather than silently deleting their new feature. Keep it out of the MVP path unless the product decision changes.
- Original `processed_webhooks` data and message IDs are not a lock or send-deduplication mechanism. Turn replay now has its own table; consolidate historical bookkeeping when ingestion/outbox design is finalized.
- `auth.ts` caches a single Google token process-wide, independent of credentials. Acceptable only under a single fixed credential assumption; key the cache when supporting credential rotation/multiple clients. HTTP auth/client calls also need bounded timeouts and response validation.

## Test coverage and how to run it

```sh
npm run typecheck
npm test
```

`src/bookings/service.test.ts` includes three schedule tests and a lightweight mocked sequential booking test. Its fake `batch` doesn't execute SQL and the test manually populates maps; do not use it as evidence of transaction correctness.

`src/calendar/client.test.ts` checks event ID derivation and a simulated Calendar store. The HTTP fake now enforces POST creation, PATCH-existing semantics and conflict recovery instead of accepting PUT as an upsert. It still doesn't authenticate against Google.

`src/llm-integration/tests/d1-integration.test.ts` uses Miniflare's local D1 implementation and applies actual migrations. It exercises conversation checkpoints, consent, latest history, turn replay, real booking/job inserts, sequential idempotency, argument conflicts, foreign-customer lookup isolation, missing Calendar config and failed cancellation. All provider calls remain mocked. There are no real credentials or remote database writes.

Remaining coverage: concurrent bookings/turns, Calendar-success/DB-failure recovery, full reschedule/cancel idempotency, notification claims/consent/reconciliation, real provider auth and an allowlisted end-to-end DM flow.

Google insert reference: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
