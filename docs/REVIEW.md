# Shared hourly roster implementation

## Current design

- **One Google Calendar event per one-hour slot**, identified by a hash of its canonical UTC start time. Equivalent Dallas-offset/UTC timestamps use the same ID.
- **One D1 booking per prospect.** All bookings in the same slot reference the same Calendar event. Notifications, consent and operation keys remain per person.
- Roster descriptions contain names, phone and/or Instagram handle, language, booking ID, gym address and timezone. Instagram scoped numeric IDs are not handles.
- An Instagram-only booking is allowed; it does not grant WhatsApp consent or create WhatsApp notification jobs.
- Cancelling removes only that booking's roster entry. Rescheduling rebuilds both the old and new slot; the original class event is never moved.
- Empty slot events remain visible with **0 prospects**, so their stable event IDs can be reused without dealing with deleted-event tombstones.

## Single implementation path

`D1BookingService` persists the desired booking change and pending operation in one D1 batch before contacting Google. Partial unique indexes enforce one active booking and one pending mutation per customer. Operation arguments and revisions are checked; a completed retry replays its original result.

`syncSlotRoster` fetches the Calendar event **before** loading the latest D1 roster. Updates use `If-Match` with the event etag. A create conflict (409) or update conflict (412) reloads both Calendar and the roster. This prevents blind text appends and stale snapshots overwriting a concurrently added prospect. There is no fallback that adopts an unrelated event merely because it has the same start time.

Google/DB partial failures leave a persisted pending operation. The same operation ID is retried, preserving its booking ID. A leased reconciliation pass runs before the notification scheduler; completion is fenced by the lease owner. A change is only reported successful after all affected rosters are synchronized. During a two-slot move, the two Calendar updates are not externally atomic; the operation remains pending until both finish.

The old per-prospect Calendar create/update/delete methods and separate append-only roster implementation have been replaced, not retained as alternatives. D1 booking rows remain intentionally individual: they are necessary to cancel one person without deleting a whole class.

## Database upgrade

Apply migrations in order, including **`0003_shared_slot_rosters.sql`**. It adds Instagram contact storage, pending-operation slot/lease metadata and uniqueness indexes. An existing duplicate active booking will make the unique-index migration fail rather than silently discard data.

No live provider setup has been completed in this project. The SQL upgrade does not delete or merge pre-existing remote Google events. If a developer created test events with the previous implementation, use a fresh test calendar/database or explicitly reconcile those test events before testing the shared design. Do not apply this as an automatic conversion of an already-live calendar.

## Tests

```sh
npm run typecheck
npm test
```

Local D1 tests execute actual migrations and queries. Google/OpenAI/Meta remain mocked. Coverage includes:

- Two concurrent prospects joining one slot and sharing its event ID.
- Phone-only and Instagram-only contact details; WhatsApp jobs only for consenting phone contacts.
- Equivalent timezone representations, exact one-hour duration and complete roster descriptions.
- Replaying create/change/cancel operations without duplicate people or jobs.
- Moving one prospect while another remains in the original class.
- Removing the last prospect and reusing the empty event for a later booking.
- Calendar timeout after accepting a write; database failure after Calendar sync.
- A partial two-slot move, cancellation outage and scheduled reconciliation.
- Concurrent create attempts for one customer, revision/argument conflicts and ownership isolation.
- Calendar optimistic-concurrency conflicts reload current roster state.
- Conversation checkpoint, consent, handle, latest-history and processed-turn persistence.

## Runtime completion

Durable inbox/queue processing, fenced conversation leases, outgoing outbox, notification lease/retry/receipt handling, shared-slot health checks and alerts are now implemented. Instagram Login uses its own endpoint/token; WhatsApp credentials are separate. The Google token cache is keyed to a credential hash. One-time channel linking, opt-outs, language handling, change/cancel tools and retention are covered by local tests.

Owner edits follow a display-only policy: time/deletion changes pause all slot notifications and raise an alert; roster text is app-maintained. Restoring a valid event clears the alert. Uncertain sends are quarantined for receipt/operator resolution rather than blindly retried. See [OPERATIONS.md](OPERATIONS.md).

Remaining work requires real accounts/credentials, live-provider verification and owner approval of the business policies. No public deployment has been verified.

The concise owner-assigned checklist lives in [ROADMAP.md](../ROADMAP.md).
