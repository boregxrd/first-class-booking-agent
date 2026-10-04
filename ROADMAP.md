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

## Google Calendar integration test

For a live API check (the normal test suite uses a fake Calendar transport):

1. Enable the Google Calendar API for the service account and share a **dedicated test calendar** with its email. Do not use the live booking calendar; this test creates a real event and leaves it for manual inspection.
2. Add `GOOGLE_CALENDAR_ID`, `GOOGLE_CLIENT_EMAIL`, and `GOOGLE_PRIVATE_KEY` to the ignored local `.dev.vars` file.
3. Choose an unused future slot, preferably on the hour in Dallas time, then run:

   ```sh
   set -a
   . ./.dev.vars
   set +a
   GOOGLE_CALENDAR_INTEGRATION=1 \
   GOOGLE_CALENDAR_TEST_SLOT='2026-10-06T14:00:00-05:00' \
   npm run test:calendar:integration
   ```

4. In Google Calendar, confirm the **“DWC Free Trials — 2 prospects”** event at that time, its gym location, and the two `Integration Test` entries in its description. The test prints the event ID on success.

The test refuses to modify an event if the chosen deterministic slot already exists. Choose a different unused slot for each rerun. See [operations](docs/OPERATIONS.md) for details.
