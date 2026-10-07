# Direct chat and live agent integration test

`POST /test/chat` runs the existing conversation processor, real OpenAI client, remote D1 and booking service, and configured Google Calendar. It returns the reply, booking status, model usage, latest booking (including cancelled bookings), and a fresh read of its Calendar event. It works independently of Meta observe/test/live mode.

## Setup and interactive chat

From the repository, with Cloudflare CLI login available:

```sh
npm run chat:setup
npm run deploy
npm run chat
```

Setup generates a random token, saves it to the ignored `.direct-chat-token` file with owner-only permissions, and installs `DIRECT_CHAT_TOKEN` as a Worker secret. It never prints the token. The endpoint is disabled if the secret is absent and requires `Authorization: Bearer <token>` on every request.

The chat command prints a conversation ID. Continue the same conversation later with `npm run chat -- <conversation-id>`. A different ID represents a different prospect. Ask questions, supply a synthetic name and Instagram handle, choose a valid future class, and answer the summary with `yes confirm` or `sí confirmo`. Ask to reschedule/cancel and confirm again.

For a single scripted turn: `npm run chat -- --send <conversation-id> "message" [message-id]`. Supply the same message ID when retrying a failed request.

Bookings are **real**, in the Calendar configured on the Worker. Use the dedicated test calendar. Cancel synthetic bookings after testing; empty slot events remain by design. Direct conversations have a reserved account namespace and create neither Meta outgoing messages nor WhatsApp notification jobs, even if a phone is provided. Cross-channel linking is unavailable for direct chats.

## Automated live check

```sh
npm run test:agent:integration
```

This creates two synthetic prospects in one slot, checks both names in the actual Calendar response, replays confirmations to check idempotency, moves one prospect, checks the old and new rosters, and cancels both bookings. It selects valid future weekday morning slots dynamically. It uses real model calls and asserts their token usage. A failure stops the test and prints conversation/message IDs; inspect the records and continue those conversations to resolve/cancel any remaining test bookings.

Override `DIRECT_CHAT_URL` for another deployment or local Worker; override `DIRECT_CHAT_TOKEN` to use a token supplied through the environment rather than the local file. Node.js 22+ is required.

## HTTP contract

```json
{
  "conversationId": "manual-ana",
  "messageId": "turn-1",
  "text": "Hola, quiero reservar mi clase gratis."
}
```

Both IDs accept 1–80 letters, digits, underscores or hyphens; text accepts 1–4000 characters. Use a new message ID for each turn and the **same ID on retry**. Send turns sequentially; a concurrent turn returns 409. A completed retry replays the reply; booking/Calendar fields report the current state. Errors expose HTTP status but no provider response bodies or credentials. If Calendar synchronization is pending, the reply says so; cron performs the normal recovery. Send a new turn later to check the result.

To disable the endpoint: `npx wrangler secret delete DIRECT_CHAT_TOKEN`. This test validates the synchronous agent/booking path. Queue wake-ups/recovery, actual Meta signatures, Instagram/WhatsApp delivery and receipts still require their own checks. Missing owner FAQs and business-policy approval are not established by a passing test.
