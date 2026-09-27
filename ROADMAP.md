# TODO

## Booking service — friend

- [x] One shared one-hour Calendar event per slot, listing each prospect's name, phone/Instagram, language and booking ID.
- [x] Reschedule/cancel individual prospects without moving or deleting everyone else's event.
- [x] Prevent duplicate active bookings; persist changes before Calendar sync and retry interrupted operations.
- [x] Rebuild rosters from D1 with Calendar conflict protection; test shared-slot updates and failures locally.
- [ ] Define how owner edits/deletes a shared event affect the entire class; add reconciliation and alerts.
- [ ] Finish notification retry/lease recovery, delivery tracking and cancellation-during-send tests.
- [ ] Confirm lead time, booking horizon, closures, repeat-trial rules and reminder timing.
- [ ] Set up Google Calendar credentials and approved WhatsApp templates.
- [ ] Apply all migrations, then test shared rosters, rescheduling, cancellation and per-person reminders against real providers.

## Agent and credentials — you

- [x] Accept name plus phone or Instagram handle; request WhatsApp permission only when a phone is supplied.
- [ ] Process incoming messages through a durable queue, in order per customer.
- [ ] Save outgoing replies and retry safely without losing or duplicating messages.
- [ ] Finish webhook validation and fix sending for the Instagram Login API.
- [ ] Handle separate channel credentials, token expiry, messaging windows and send failures.
- [ ] Finish Instagram/WhatsApp identity linking, opt-outs and language handling.
- [ ] Add reschedule/cancel tools; set up history cleanup and error monitoring.
- [ ] Add tests for simultaneous messages, failed sends and webhook retries.
- [ ] Create Cloudflare account, deploy Worker, create D1/Queues and apply migrations.
- [ ] Add the OpenAI key; create Meta app and have your brother authorize Instagram.
- [ ] Connect webhooks; receive a test DM in observe-only mode, then allow only your sender ID.
- [ ] Confirm missing gym FAQs and coordinate testing/cutover with the existing bot.
- [ ] Test two prospects booking the same hour: one Calendar event, two roster entries, separate confirmations.

Design/testing details: [review](docs/REVIEW.md). Account setup: [guide](docs/meta/README.md).
