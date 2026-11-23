# Roadmap

Updated 2026-11-23. [jira-backlog.md](jira-backlog.md) is the source of truth for task status and ownership. Checked items below describe implemented or explicitly verified work; pending live checks remain separate even when the implementation task is Finished.

Latest local verification: TypeScript checks and **136/136 tests passed** on 2026-11-23. Providers are mocked in the normal suite. The tone and confirmation changes for #2/#4 are local and **not deployed**. Latest documented deployment: `1097b88d-8718-4e74-9a23-b2b5bbfe1fe6` on 2026-11-17; no fresh production inspection was performed for this update.

## Booking and messaging foundation

- [x] Shared hourly Calendar rosters; individual bookings, rescheduling and cancellation.
- [x] Duplicate prevention, idempotent replay, interrupted-operation recovery and concurrent roster protection.
- [x] Owner-edit policy implemented: pause slot notifications and alert on time changes/deletion; rebuild roster text from D1.
- [x] Durable inbox/queue processing, per-conversation locking, ordered replies and outgoing-message persistence.
- [x] Bounded notification retries, lease recovery, delivery receipts and quarantine of uncertain sends.
- [x] Webhook validation, account-scoped credentials, messaging-window checks and token-expiry handling.
- [x] One-time cross-channel linking, opt-outs, language controls, retention and operational alerts.
- [x] Instagram profile lookup with confirmed booking name and explicit day/time/phone intake (#3/#13).
- [x] Dallas date/weekday contradiction guards, stale-proposal rejection and protected attributed-calendar testing (#16).
- [x] Gym-wide 30-day trial eligibility using D1 customer/phone/Instagram-handle history (#5). This does not inspect external Calendar history or establish attendance.
- [x] WhatsApp confirmation and 24-hour/1-hour reminder scheduling with consent checks (#7). Real sending remains gated by #6.
- [x] Confirmed service-result checks and local guards against common premature model success claims and unsupported approval requests (#4). Wording recognition is bounded; see [acceptance details](docs/CONVERSATION_ACCEPTANCE.md).

## Multi-account onboarding and attribution

Implementation of #9, #14 and #8 is Finished and accepted in the backlog. Additional live acceptance remains below.

- [x] Minimal distribuidora profiles, isolated encrypted social credentials and persistent booking/calendar attribution.
- [x] Owner-authorized portal, gym Google OAuth, automatic gym-owned calendar creation and reader sharing.
- [x] Separate Gmail connection invitations, one-use Instagram OAuth and account messaging subscription.
- [x] Registered-account routing, correct-account replies and recovery using each booking's saved calendar.
- [x] Central gym WhatsApp sender selection and optional source-attribution template support; sending remains disabled.
- [x] Migrations through 0008 applied remotely; existing bookings/calendars preserved.

Setup, recovery and credential rotation: [owner portal](docs/OWNER_PORTAL.md). Requirements and remaining acceptance: [multi-account plan](docs/MULTI_ACCOUNT_PLAN.md). Historical evidence: [handoff](docs/MULTI_ACCOUNT_HANDOFF.md); its older task-status labels are superseded by the backlog.

## Recorded live verification

- [x] Cloudflare Worker, D1, queues and cron configured; real OpenAI calls verified.
- [x] Protected direct-chat two-prospect booking/reschedule/cancel/replay checks with real D1 and Calendar (2026-10-07).
- [x] Real Instagram inbound signature acceptance, queued processing and received reply.
- [x] Gym Google calendar ownership, service-account writer and distribuidora reader ACLs verified; Gmail accepted connection invitations.
- [x] Professional tester accepted its role; native Instagram OAuth, identity, subscription and long-token expiry verified (2026-11-17).
- [x] Dinosaurio replies confirmed by the user; 11 processed inbound and 11 accepted outbound messages recorded.
- [x] Protected attributed-calendar booking, replay without duplication, cancellation and date-conflict regression verified (2026-11-17). Synthetic booking cancelled; Calendar roster returned to zero prospects, with no notification jobs.

Repository configuration enables registered multi-account routing and `META_MESSAGING_MODE=live`; WhatsApp notifications and attribution templates remain disabled. App publication and successful tester authorization do not establish public Meta permission approval.

## Next steps

1. **Tone acceptance and deployment — Félix, #2 In progress.** Review representative Spanish/English real-model conversations using the [acceptance checklist](docs/CONVERSATION_ACCEPTANCE.md). The local tone guidance/examples and deterministic responses are updated. Deploy the verified #2/#4 changes and record the version and resulting live checks.
2. **Additional Instagram acceptance.** Verify actual DM → summary approval → correct calendar → same-account reply, compare the general DWC account, and test rescheduling, cancellation, disconnect isolation and reconnect. Protected calendar checks and real replies already passed separately; the complete Instagram booking/lifecycle flow remains pending.
3. **Meta external-account access — Manu, #15 In progress.** Complete the working screencast, stable reviewer access and exact dashboard prerequisites; submit the two required permissions and record Meta's response. No review submission or approval is recorded. Use the [review packet](docs/META_APP_REVIEW.md).
4. **Gym WhatsApp activation — Manu, #6 Todo.** Obtain access to the number, configure Cloud API credentials/subscriptions and approved templates, select the gym sender, then verify actual confirmations, reminders, receipts and opt-outs. Enable notification sending only after configuration and consent checks. Enable attribution templates only after the corresponding templates are approved.
5. **Owner launch decisions.** Approve the Calendar display/edit policy, lead time, booking horizon, closures, repeat-trial rules and reminder timing. Confirm missing FAQs, the intended production Instagram account and credential expiry, and coordinate any existing bot's cutover.
6. **TikTok DMs — Félix, #10 Todo.** Implement actual provider authorization, webhooks and messaging using the prepared adapter boundary once provider access is established. This work was excluded from the current Félix changes.
7. **Comment-triggered private messages — #11/#12 Todo, unassigned.** Leave Instagram and TikTok comment automation until last.

## Verification commands

Local checks:

```sh
npm ci
npm run typecheck
npm test
```

Protected chat: `npm run chat`. Live agent integration: `npm run test:agent:integration`. These use real deployed services and can create bookings; follow the [direct-chat guide](docs/DIRECT_CHAT.md), use authorized synthetic prospects and cancel test bookings afterward.

For a standalone real Calendar API check, use a **dedicated test calendar** shared with the service account. Put `GOOGLE_CALENDAR_ID`, `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` in the ignored `.dev.vars`. Choose an unused future Dallas slot and run:

```sh
set -a
. ./.dev.vars
set +a
read -r -p 'Unused future Dallas slot with UTC offset (YYYY-MM-DDTHH:00:00±HH:MM): ' GOOGLE_CALENDAR_TEST_SLOT
export GOOGLE_CALENDAR_TEST_SLOT
GOOGLE_CALENDAR_INTEGRATION=1 npm run test:calendar:integration
```

The test creates a real event, updates it to two synthetic prospects and reads it back. It refuses to overwrite an existing deterministic slot and leaves its event for manual inspection. Check the `DWC Free Trials — 2 prospects` title, location and roster. Choose a new unused slot for every rerun.

Runtime recovery, notification handling and monitoring: [operations](docs/OPERATIONS.md). Initial provider setup: [Meta setup](docs/meta/README.md), whose historical setup milestones should be read alongside the newer backlog and dated verification records.
