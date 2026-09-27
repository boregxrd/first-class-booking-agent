# Runtime setup and recovery

## Before enabling traffic

1. Install dependencies: `npm ci`; run `npm run typecheck` and `npm test`.
2. After Cloudflare login, create `dwc-booking-db`, `dwc-messages`, and `dwc-messages-dlq`. Replace the zero UUID in `wrangler.jsonc` with the real D1 ID. Review Cloudflare plan/limits for the configured resources.
3. Apply **all** migrations in order, including `0004_durable_messaging.sql`. The local test suite does this on an isolated Miniflare database. Example remote command after account setup: `npx wrangler d1 migrations apply dwc-booking-db --remote`.
4. Set secrets/configuration from `.dev.vars.example`. Local `.dev.vars` is not deployed automatically. Use separate Instagram Login and WhatsApp access tokens, the proper account IDs and a supported Graph API version selected in Meta.
5. Start with `META_MESSAGING_MODE=observe` and `WHATSAPP_NOTIFICATIONS_ENABLED=false`. Enable `test` only with exact sender IDs; WhatsApp IDs in the allowlist contain digits only.
6. Configure approved template names before enabling notifications. `WHATSAPP_NOTIFICATIONS_ENABLED=true` is a separate opt-in; in test mode recipients must also be on the WhatsApp allowlist.
7. Configure actual token-expiry timestamps. Expired/invalid tokens fail closed; expiry within seven days raises an operational alert. Refresh/re-authorize through the provider and update the secret/expiry. No user login or authorization is fabricated by the application.

Worker, queue and every-minute cron handlers are implemented. No account/resource has been created or deployed by the local tests.

## Inbox and conversation recovery

- `message_inbox` is the durable source. Queues carries wake-ups, not the only copy of a message. A failed queue publication raises an alert and cron recovers the inbox.
- Messages process in receipt order for each channel/account/sender. Leases expire after ten minutes; transaction fences reject expired writers. Booking operations have their own idempotency/leases.
- Processor failures back off from 30 seconds to one hour. After six failures, the inbox item is `failed`, an alert opens, and later messages in that conversation wait.
- After fixing the cause, an authorized operator can reset a specific failed inbox row to `state='pending', attempts=0, available_at=<current UTC time>`. Do not delete deduplication rows or reorder a conversation to bypass an error.
- The configured Queue dead-letter queue captures infrastructure-level retries. Inspect it alongside the inbox; replaying a wake-up is safe because D1 owns deduplication.

## Outgoing messages and reminders

Delivery progresses `pending → leased → sending → accepted`, with `failed`, `unknown`, or `cancelled` branches.

- An expired **leased** job had not started sending and is retried.
- An expired **sending** job or ambiguous network response becomes **unknown**. Do not automatically reset it to pending: the provider might have accepted it.
- Explicit transient rejection retries at most six times with backoff. Accepted messages are not sent again.
- WhatsApp callback correlation IDs allow early receipts to resolve sending/unknown records. Receipt processing deduplicates events and never regresses delivered/read to a late failure.
- Unknown/failed chat replies block later replies in that conversation to avoid sending them out of order. Inspect provider history first. If delivery is verified, record the provider ID and accepted state; if non-delivery is verified and the window is still open, an operator may retry. If unresolved, obtain customer re-engagement and resolve deliberately rather than promising exactly-once delivery.
- Standard text replies require a recent incoming message within 24 hours. Outside that window, a text send fails rather than silently using an unapproved template.
- A reminder rechecks booking revision, future time, latest matching consent, pending mutations and the shared Calendar event. A cancellation either cancels a leased job or receives a retryable result while a send is already in flight. It must not claim a message was retracted after the send started.

## Shared Calendar owner-edit policy

**Calendar is an app-maintained display.** Names, contact details and roster text are rebuilt from D1. Individual changes belong in booking operations/chat.

- Moving, deleting or changing the duration/status of an event quarantines the entire slot: notifications pause and `calendar_slot_blocked` opens.
- The application does not infer new times for every customer or silently cancel everyone. Restore the original event/time (including from Google trash if necessary), or coordinate deliberate booking changes. Once the event is healthy, reconciliation clears the alert and pending jobs can resume.
- Title/roster-description edits are overwritten from D1. Empty slots retain their stable event ID with zero prospects.
- The owner must approve this policy and the configured lead time, horizon, closures and repeat-trial rules before launch.

## Monitoring and retention

Worker logs contain operational IDs, statuses and model token counts, not raw chat bodies/tokens. Cloudflare observability is enabled. Inspect `operational_alerts` for open errors, `message_inbox` for failed turns, outgoing/notification jobs for unknown/failed delivery, and `calendar_slot_health` for quarantined classes. Example after login:

```sh
npx wrangler tail
npx wrangler d1 execute dwc-booking-db --remote --command "SELECT kind, resource_id, detail, updated_at FROM operational_alerts WHERE state = 'open' ORDER BY updated_at DESC"
```

Alerts are stored and logged; external paging destinations require a separately configured monitoring integration. They are not automatically sent to staff phones.

Default cleanup: raw chat text is retained for 30 days; processed-turn/receipt metadata for 90 days. Pending work is preserved. Expired linking codes and proposals are removed, and completed past bookings become elapsed without implying attendance or membership. Customer/booking/consent records remain. Operator resolution should happen before failed/unknown outgoing text ages out.

## Local verification

`npm test` covers actual D1 SQL/migrations, shared roster concurrency/recovery, FIFO/inbox/outbox behavior, malformed webhooks, separate provider tokens, windows/expiry, early receipts, manual owner edits, cancellation during send, one-time linking, opt-outs, language and the two-prospect flow. Providers are mocked; real token scopes, actual Meta windows, template approvals, model tone and Google authorization still need live verification.
