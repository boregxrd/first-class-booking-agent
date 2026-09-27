# TODO

## Booking service — friend

- [ ] Prevent duplicate bookings when requests retry or arrive together.
- [ ] Recover safely when Calendar succeeds but the database update fails.
- [ ] Make rescheduling and cancellation safe to retry.
- [ ] Keep bookings/reminders in sync when the owner edits Calendar.
- [ ] Send reminders only for current bookings with WhatsApp permission; handle delivery failures.
- [ ] Confirm booking rules: lead time, booking horizon, closures, repeat trials and reminder timing.
- [ ] Keep one Calendar event per prospect; resolve the unused shared-roster alternative.
- [ ] Set up Google Calendar credentials and approved WhatsApp templates.
- [ ] Add failure/concurrency tests; test real booking, change, cancellation and reminder delivery.

## Agent and credentials — you

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
- [ ] Test the full flow together: DM → AI → confirmed booking → Calendar → reply/reminder.

Technical details: [review](docs/REVIEW.md). Account setup: [guide](docs/meta/README.md).
