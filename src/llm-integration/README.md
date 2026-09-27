# Agent and messaging runtime

`src/index.ts` only mounts HTTP handlers and delegates queue/cron work. Composition lives in `src/runtime/factory.ts`.

## Message flow

1. `src/channels/meta.ts` verifies the signature and runtime payload shape, filters accounts/echoes/test users, then commits normalized messages to D1's inbox.
2. Cloudflare Queues wakes the consumer. Cron also scans the inbox, so a failed queue publication does not lose committed messages.
3. The processor uses a recoverable, fenced D1 lease per channel/account/sender. Inbox sequence preserves receipt order; failed earlier turns cannot be overtaken.
4. `agent/client.ts` calls OpenAI using the prompt and bounded history. The model proposes bookings/changes; explicit customer confirmation authorizes execution.
5. `conversations/d1-store.ts` atomically commits state, processed-turn result and outgoing reply. Replayed webhooks do not create another reply.
6. The outbox sender uses the correct channel API and token, enforcing the messaging window and send-state recovery rules.

## Configuration and behavior

- Edit `gym-context.ts` for approved facts/FAQs/voice; `agent/prompt.ts` for conversation guidance.
- The authoritative schedule lives in `src/gym/schedule.ts`. Classes last 60 minutes, timezone `America/Chicago`.
- Model defaults to `gpt-4.1-mini`, configurable with `OPENAI_MODEL`; 20-second request timeout, 600 output tokens and four rounds per turn.
- Tools: `getClassSchedule`, `getBooking`, `proposeTrial`, `proposeReschedule`, `proposeCancellation`. Identity, revision and operation keys are supplied by code.
- A prospect needs a name and phone or Instagram handle. A phone-based confirmation asks for WhatsApp consent; Instagram-only bookings do not create WhatsApp notifications.
- Proposals expire after 30 minutes. A correction invalidates the previous proposal. `sí confirmo` / `yes confirm` executes the current action.
- `STOP`, `unsubscribe`, `no más mensajes`, or `cancelar mensajes` revokes notification consent without cancelling the booking.
- `English` / `Español` changes the stored language. Common English/Spanish greetings also set the initial language.
- From Instagram, `vincular WhatsApp` / `link WhatsApp` issues a 15-minute one-time code after a phone is recorded. Send `vincular CODE` / `link CODE` from that exact WhatsApp number. A phone match alone never links identities.

Google Calendar contains one shared roster per hour; the agent never moves/deletes a whole event to modify one customer's booking.

## Delivery guarantees and limits

D1 prevents duplicate processing and stores replies durably. Explicit provider rejections use bounded backoff. Network timeouts, missing provider IDs and interrupted sends become **unknown** and raise an alert rather than blindly resending. Exactly-once delivery across an external messaging API cannot be guaranteed without provider idempotency; see [operations](../../docs/OPERATIONS.md) for resolution.

Code is wired, but no real credentials or deployment have been used. Unit/local-D1 tests mock external providers. Run `npm run typecheck` and `npm test`; complete the live tests in [ROADMAP.md](../../ROADMAP.md) before public use.
