# Messaging and agent integration (Part A)

`src/index.ts` remains the Worker entrypoint. New Part A application code lives here. For the latest integrated status and remaining defects, see [ROADMAP.md](../../ROADMAP.md) and [docs/REVIEW.md](../../docs/REVIEW.md).

## Gym context

- Edit `gym-context.ts` for approved business facts, FAQs, advertised hours and voice preferences.
- Edit `agent/prompt.ts` for the booking conversation rules and tone examples.
- Unknown owner details are explicitly `null`; fill them with approved information rather than guesses.
- `BookingService.getClassSchedule()` owns the executable schedule, duration and date-specific closures. Its returned schedule replaces advertised hours in the prompt. Coordinate schedule changes with the Calendar owner.

`buildSystemPrompt({ now, schedule })` is provider-independent. The processor sends it as the system instruction, then appends recent customer/assistant messages and tool results in their proper roles. Customer text must not be interpolated into system instructions.

## Model and processor

- `agent/client.ts`: Workers-native OpenAI Chat Completions client, default `gpt-4.1-mini`, configurable via `OPENAI_MODEL`. Includes a 20-second timeout, runtime response validation, usage counts and a 600-token output cap. Request failures propagate to the caller; no hidden retries.
- `agent/tools.ts`: strict tool argument validation and Dallas schedule checks. The model can read the schedule or **propose** a trial; it cannot directly create a booking.
- `conversations/processor.ts`: up to four model rounds per turn, latest 20 text messages, persisted proposal/operation checkpoints and deterministic booking confirmation replies.
- `conversations/store.ts`: required durable store interface. `d1-store.ts` now implements persistence, but serialization and outbound outbox are still pending. In-memory test fixtures are never used as a runtime fallback.
- `runtime/create-processor.ts`: constructs the real model client and processor from Worker environment, a conversation store and Part B's BookingService.
- `runtime/queue.ts`: validates normalized messages, acknowledges successful durable processing and requests retries after failures. The default exported handler deliberately fails until adapters are configured.
- `webhooks/routes.ts`: HTTP plumbing for the existing Meta adapter. `src/index.ts` mounts these routes and delegates queue handling.

OpenAI's model page lists GPT-4.1 mini at $0.40 per million input tokens and $1.60 per million output tokens: https://developers.openai.com/api/docs/models/gpt-4.1-mini . At 5,000 calls with 2,000 input and 150 output tokens each, that's approximately $5.20 for the model; longer prompts and tool rounds increase this. Meta and Cloudflare charges are separate.

### Booking confirmation

The model collects name, international WhatsApp phone and class time, then calls `proposeTrial`. The processor validates these and emits a summary with a request to reply **“sí confirmo” / “yes confirm”** to approve the reservation and WhatsApp confirmation/reminder. Only that reply to a current proposal calls BookingService; a model boolean is never authorization. The proposal expires after 30 minutes. A question or correction invalidates the old proposal, requiring a fresh summary. Other affirmative phrases currently need clarification rather than automatically booking.

The durable checkpoint saves the customer/consent and stable booking-operation key **before** invoking Calendar through BookingService. Retries reuse the key. Store implementations must serialize conversations, atomically persist processed-message results and pending outbound replies, and make customer fields available to BookingService. BookingService still enforces customer ownership, eligibility and idempotency. Outbound dispatch must enforce its own send-state policy; returning a cached turn must not resend an already delivered reply.

### Remaining live wiring

This is a tested processor core, **not yet a reliable end-to-end DM bot**. In default observe mode, Meta handlers log metadata only. Test/live modes currently invoke the processor inline; this must be replaced with durable ingestion. Remaining integration work:

1. Finish D1 conversation serialization and outbound outbox (base storage now exists).
2. Webhook normalization + durable queue publication before HTTP acknowledgement.
3. Queue bindings/retry limits/dead-letter queue in Wrangler.
4. Connect the composed services in `src/runtime/factory.ts` to `createQueueHandler`.
5. Correct the outbound Instagram Login adapter and add reliable dispatch/delivery tracking; deferred booking-operation reconciliation.
6. Change/cancel tools, identity linking and consent withdrawal handling before production rollout.

Store `OPENAI_API_KEY` as a Worker secret; use `.dev.vars` locally. Workers host the HTTP API/processor. D1 stores application state. Queues hand off webhook work. Google Calendar remains Part B's integration. Tests use mocked provider requests and a test-only store; no live model or Meta calls are made.

Run `npm run typecheck` and `npm test`.

Class duration is confirmed as **60 minutes**. Before launch, confirm prices (if shared), parking, what to bring, arrival guidance, cancellation/repeat-trial rules, closures and booking lead time with the owner. Part B's authoritative schedule should also use this duration.
