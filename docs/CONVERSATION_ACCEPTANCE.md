# Conversation acceptance — tasks #2 and #4

## Local implementation, 2026-11-23

The style guidance answers the customer's question first, avoids repeated invitations,
uses at most one emoji and avoids emojis for errors or refusals. It reuses known
information and asks only for missing details. Spanish and English examples retain
the approved gym facts and booking policies.

Only the processor announces a completed booking mutation after validating the
booking service result. Pending synchronization retains the approved operation for
an idempotent retry; failures do not return a success confirmation. The model text
path also checks common Spanish/English success claims and approval requests,
asks the model to use the appropriate tool, and falls back without announcing
success if correction fails. This wording check is bounded; it is not an exhaustive
semantic classifier of all possible model output.

Automated regressions cover proposal-before-approval, duplicate confirmations,
timeouts, pending/retry, permanent failure, inconsistent service success, unsupported
model success claims and approval requests. Existing booking/notification tests cover
calendar recovery, trial eligibility, reminder timing, consent and cancellation.

Run `npm ci`, `npm run typecheck` and `npm test` before deployment.

## Remaining live tone acceptance (#2)

Use protected direct chat for initial tone checks (see `DIRECT_CHAT.md`). Creating
or approving bookings writes to real D1/Calendar, so use authorized synthetic
prospects, a dedicated test calendar, future Dallas slots and cancel test bookings.
Actual Instagram delivery and WhatsApp delivery require separate provider checks.

For each case, record the input, reply, language, deployment and pass/fail:

| Case | Expected behavior |
|---|---|
| First greeting, then another question | Brief welcome once; no repeated introduction. |
| Beginner asks about class format | Direct answer; no forced booking question. |
| Several FAQ questions | Short contextual answers, no repeated pet names or invitation. |
| Unknown price/parking information | Admit the missing fact without inventing an answer or promising a call. |
| Only a time, then a day | Ask for the day first; retain the selected time. |
| Name/phone already supplied | Reuse them; ask only for missing information. |
| English conversation | Natural English throughout, including deterministic responses. |
| Customer asks for no emojis or pet names | Respect their preference in model-generated replies. |
| Eligibility restriction | Brief, respectful explanation; no workaround or emoji. |
| Corrected or conflicting date | Clarify Dallas date without approving a stale summary. |
| Booking, change or cancellation request | Saved summary first; completed result only after explicit approval and service success. |
| Provider failure or delayed calendar synchronization | Honest pending/failure response without promising completion or delivery. |

Task #2 remains in progress until representative real-model conversations have
been reviewed. A passing mock-provider suite verifies behavior, not natural tone.
WhatsApp number/template activation and actual reminder delivery remain task #6;
TikTok and comment-triggered automation are outside this change.
