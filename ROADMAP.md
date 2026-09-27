# TODO

Checked items are implemented and tested locally; live-provider verification is still required.

## Booking service — friend

- [x] Shared hourly Calendar rosters; individual bookings, changes and cancellations.
- [x] Duplicate prevention, interrupted-operation recovery and concurrent roster protection.
- [x] Owner-edit policy: pause the whole slot's notifications and alert on time changes/deletion; rebuild edited roster text from D1.
- [x] Notification retries, lease recovery, delivery tracking and cancellation-during-send protection.
- [x] Local tests for Calendar/database failures, owner edits, consent and out-of-order receipts.
- [ ] Owner: approve the display-only Calendar policy, lead time, booking horizon, closures, repeat-trial rules and reminder timing.
- [ ] Set up Google Calendar credentials, WhatsApp number and approved templates.
- [ ] Test real shared rosters, rescheduling, cancellation and per-person reminders.

## Agent and credentials — you

- [x] Phone or Instagram contact, explicit booking confirmation, reschedule/cancel tools.
- [x] Durable inbox/queue processing, per-conversation locking and ordered replies.
- [x] Outgoing-message persistence, bounded retries and alerts for uncertain sends instead of blind resends.
- [x] Runtime webhook validation, Instagram Login sending, separate channel credentials and messaging-window checks.
- [x] Token-expiry checks/alerts, secure one-time cross-channel linking, opt-outs and language commands.
- [x] History retention, structured usage/error logs, scheduled recovery and operational alerts.
- [x] Local concurrency/failure tests and two-prospect end-to-end flow with mocked providers.
- [ ] Create Cloudflare account/resources, replace placeholder DB ID, apply migrations and deploy.
- [ ] Add OpenAI/Meta credentials and token expiry dates; have your brother authorize Instagram.
- [ ] Connect webhooks; observe a real DM, then enable only your sender IDs for testing.
- [ ] Owner: confirm missing FAQs and coordinate the existing bot's testing/cutover.
- [ ] Verify actual model tone/tool behavior, real Meta sends and the complete two-prospect booking flow.

Setup: [guide](docs/meta/README.md). Runtime/recovery: [operations](docs/OPERATIONS.md).
