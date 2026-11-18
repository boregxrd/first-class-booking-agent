# Multi-account booking: agreed requirements

## Model and ownership

- One shared gym context and group-class schedule; calendars attribute prospects to distribuidoras, not separate teaching schedules.
- Minimal distribuidora: name, Google-sharing email, active status, calendar ID/view URL/setup status and timestamps. No kind, position or tier.
- Dallas Wellness Club is a normal distribuidora record using the existing general calendar.
- Social accounts (Instagram, TikTok, optionally WhatsApp) belong to a distribuidora. Credentials are encrypted separately, never returned by admin listing APIs.
- Bookings preserve assigned distribuidora, originating social account, and the calendar used; reconfiguration never silently moves existing bookings.
- Message history remains account-specific. Do not merge customers using display names or assume scoped social IDs are equal across accounts.

## Onboarding

- Owner-only portal creates a profile, automatically creates a secondary calendar owned by the gym Google user, shares reader access to the distribuidora email, and asks Google to send the sharing invitation.
- Only the gym Google account authorizes calendar creation/sharing. Distribuidoras never grant access to their personal calendars or receive gym login credentials.
- Keep the existing service account for event operations after giving it writer access.
- External provisioning uses persisted steps. Ambiguous creation must be reconciled before retrying; no blind duplicate calendars or invitations.
- Instagram connects through provider authorization and account-level messaging subscription. Verify account identity and capabilities server-side.
- Expose a provider adapter contract for Félix's TikTok task (#10). A login token alone is not messaging eligibility.
- Optional trainer WhatsApp requires supported Business Platform onboarding; the Business app alone is insufficient. Gym WhatsApp activation remains #6.
- Expired/disconnected accounts cannot accept new turns, but disconnecting one account must not interrupt others or silently discard existing bookings.

## Notifications

- Scheduled confirmations/reminders use only the explicitly configured gym WhatsApp social account, regardless of originating trainer/channel.
- Calendar verification follows each booking's saved calendar, not the reminder sender.
- Store originating account/handle attribution for approved templates, e.g. “Somos Dallas Wellness Club. Nos contactaste por Instagram a través de @cuenta. Tu clase gratis es …”. No message is promised delivered merely because a job/provider accepted it.

## Acceptance checklist

- [x] Creating a distribuidora creates her gym-owned calendar, grants bot writer access and her reader access, and requests sharing email notification.
- [ ] Failed setup resumes without blindly creating duplicate calendars.
- [ ] Accounts connect, reconnect and disconnect through owner-authorized flows; tokens never appear in responses/logs.
- [ ] A separate Instagram invitation email is accepted by gym Gmail and received by the distribuidora; its private 24-hour link starts one-use authorization without owner portal access.
- [ ] Two trainers receive bookings for the same class time in separate calendars.
- [ ] Main-account bookings stay in the general calendar.
- [ ] Replies use the correct originating account.
- [ ] Contacting another trainer does not silently transfer an existing booking.
- [ ] Reschedules, cancellations, retries and recovery use the booking's saved calendar.
- [ ] Reminders come from gym WhatsApp and reference the original account when the approved template supports it.
- [ ] Disconnecting one trainer account does not interrupt other trainers.
- [ ] Owners see all calendars; trainers receive read-only access only to their own calendar.

## Latest live milestone — accepted tester authorization

- On 2026-11-17, after the account holder accepted the separate Instagram Tester invitation, the fresh emailed authorization completed all callback stages. The professional account is registered as connected to dinosaurio and its pre-existing calendar, with a provider-issued long-token expiry of `2027-01-16T09:53:14.205Z`.
- The previous Unsupported request attempts had both OAuth permissions but lacked accepted tester-role access. They are historical failures, not the current state; associated past alerts were resolved after the successful callback, with their diagnostic details retained.
- Enabled `MULTI_ACCOUNT_ENABLED=true` for the two registered connected destinations in deployment `16e99117-fe03-4487-8cfb-de5755b3f241`. Unknown/inactive/unconnected accounts still do not route. This is a controlled live test, not public Meta permission approval.
- WhatsApp notification and attribution-template flags remain false. No real customer reminder sending was enabled.
- Initial activation passed 110 automated tests. The user subsequently confirmed dinosaurio replies (11 processed inbound/11 accepted outbound observed). Current suite: **121 tests**, typecheck passed. Protected real-calendar creation/idempotency/cancellation passed on Worker `1097b88d-8718-4e74-9a23-b2b5bbfe1fe6`: one attributed synthetic booking, then cancelled revision 2 and zero roster prospects/notification jobs. See handoff §13 for evidence. Actual Instagram booking approval, main-account comparison and remaining lifecycle checks stay pending.

## Delivery

Tasks #9 → #14 → #8, in focused commits with local acceptance tests. Preserve #6 and Félix's #10 as separately owned provider activation/integration work. External authorizations, approved templates and real sharing/delivery are live gates, not simulated completion.

## Verification record — 2026-11-14

- TypeScript checks and all **94 local tests** pass. Tests run real local D1 migrations/SQL with simulated Google/Meta transports, including legacy backfill, profile-creation retries, two-calendar roster isolation, immutable booking attribution after reconfiguration/disconnect, recovery/cancellation, gym-only reminder sender, source template parameters, JWT signatures/audience/owner checks, OAuth replay defense, key rotation and expired-token isolation.
- Wrangler dry-run and deployed Worker build passed. Version `c4b7fc7d-cda0-4baa-a915-75869b0fab7b` is deployed with `MULTI_ACCOUNT_ENABLED=false` and notifications still disabled.
- Migration 0007 applied remotely; authenticated bootstrap imported the existing DWC calendar/Instagram connection without recreating a calendar. Public health returns 200, protected API returns 401 without authorization, and authenticated overview returns only public account metadata.
- Owner/vault secrets installed without printing values; their ignored local backup has mode 0600. Instructions and provider callback URLs are in `OWNER_PORTAL.md`.
- **Still pending for #14/#8:** configure OAuth application clients, gym Google consent, real calendar creation/reader sharing/invitation, second real social account, and two-account live acceptance. WhatsApp template approval/delivery is #6, TikTok messaging is Félix's #10. The checklist above remains unchecked until the corresponding real-provider checks are completed.

## Live calendar verification — 2026-11-16

- Gym Google OAuth consent completed after adding the gym account as an approved test user.
- Created the owner-requested `dinosaurio` profile through the protected API; calendar `DWC — dinosaurio` reached `ready` automatically.
- Read back Google Calendar metadata and ACLs: `dataOwner` is the gym Google user, the bot service account is `writer`, the requested recipient is `reader`, and the calendar is not publicly shared. The existing general calendar's data owner was independently verified as the same gym user.
- Repeating the profile creation with the same request ID returned the same profile/calendar without re-provisioning or requesting another invitation.
- Google sharing notification was requested (`sendNotifications=true`); actual email receipt/acceptance still needs recipient confirmation.
- All **96 local tests** pass; deployed version `c7a2d100-2be9-4088-9b9f-52fe04b70e3f`. Instagram client authorization, a second connected social account and full two-account booking acceptance remain pending. Multi-account routing remains disabled during this setup.

## Complete automated pipeline coverage — 2026-11-16

- Suite now contains **97 passing tests**, including `multi-account-pipeline.test.ts`.
- The new test signs webhook payloads for two distribuidora accounts and the general DWC account, runs `processMetaWebhook` → durable inbox → production `handleQueue`/`createServices`/agent → Google Calendar client → outbox/Meta sender, and checks all three confirmed bookings' calendar and attribution fields.
- It verifies that no booking exists before approval, each calendar contains only its assigned prospect, profile lookups and replies use the receiving account's credentials, and confirmation replies return to the correct account/customer. Deliberately incorrect legacy credentials make accidental single-account fallback fail the test.
- D1 and application handlers are real; queue delivery and Google/Meta/OpenAI transports are simulated. This does not replace the pending real Instagram authorization/DM acceptance test, and does not enable multi-account routing in production.

## Emailed Instagram invitations

- Owner-requested refinement: the Instagram connection invitation is a separate **email from gym Gmail**, rather than a URL the owner must manually forward. The Google calendar-sharing invitation remains separate.
- Recipient links last 24 hours; a deliberate button starts a one-use 15-minute Instagram authorization. GET previews are safe. The email never grants owner portal access.
- Gmail needs only send permission, not inbox-reading access. Existing calendar consent must be expanded explicitly, Gmail API enabled, and Meta OAuth configured before a real invitation can be emailed.
- Local suite: **101 passing tests**, including accepted/replayed sends, ambiguous outcomes with no automatic resend, explicit rejection/retry, expiry, escaped recipient pages, scanner-safe GET and one-use POST.
- Real email delivery and recipient account authorization remain pending; Google acceptance must not be described as confirmed mailbox delivery.
- Migration 0008 applied and email-capable Worker `de7b6cdd-7527-41a7-a552-7a1d6d9ac8a3` deployed. Authenticated overview confirms no invitation email has been sent yet: Instagram OAuth is not configured and the gym's existing Google consent does not include Gmail send permission. The portal disables emailing and explains both prerequisites rather than silently generating a copy/paste link.

### First real Gmail invitation accepted — 2026-11-16

- Owner enabled Gmail API and granted send-only Gmail consent. The confirmed Instagram app ID and matching secret are now installed in Worker secrets; the secret was transferred from the owner's clipboard through stdin without being printed or stored in Git.
- Authenticated setup overview reports both Instagram OAuth configuration and Gmail send authorization ready to test.
- Gmail accepted invitation `643f6d66-6ad7-4c25-a697-c21c96e99b2e` for the existing dinosaurio profile; the private recipient link expires at `2026-11-17T23:07:38.978Z`. No duplicate email request was issued.
- Mailbox receipt, actual recipient Instagram approval/callback and a working account messaging subscription remain unverified. The live email acceptance checklist is not complete until the recipient confirms receipt. Multi-account routing remains disabled pending real account validation.

### Instagram callback diagnosis — 2026-11-16

- The recipient reached the Instagram callback after opening an emailed invitation. The second state was consumed at `23:16:26 UTC`, about seven seconds after starting and before its `23:31:19 UTC` expiry: that attempt was not blocked by expiration.
- The previous handler swallowed the provider/save exception, so its exact cause cannot be reconstructed from the old records. New version `50c25a3e-5677-42dd-94fc-32c0fc8bdfc8` records sanitized failure stages and emits diagnostic references instead of labeling every failure as expired.
- Added flat/single-entry-wrapped Instagram token handling and regression coverage for credential-error redaction and refusing to move an already-assigned account. All **104 tests** pass.
- One fresh diagnostic invitation was accepted by Gmail; actual connection remains pending a new recipient attempt. No expired/used code is replayed and no DWC account assignment is changed speculatively.

### Long-token failure isolated — 2026-11-16

- Reference `48cd9932-a2c1-4f54-a3e9-efdd0102eba1` proves the code exchange reached a valid short token, then Meta rejected the long-lived token request with HTTP 400 / code 100. The first diagnostic did not retain Meta's reason text or a retry credential, so the precise parameter rejection remains unconfirmed.
- Deployed `a935704b-1cdf-40fb-a8fe-b1cc0318033e`: bounded credential-redacted summaries, optional encrypted profile-bound token checkpoints, owner-only retry without replaying OAuth codes, and checkpoint expiry/cleanup. No account is considered connected until identity/subscription/save succeeds.
- All **107 tests** pass, including short/long checkpoint recovery, preservation of real token expiry, denial to unauthenticated/expired retries and secret redaction.
- New invitation `db32a284-ad9f-4e95-a303-acfbd1ea07a2` was accepted by Gmail. Waiting for the recipient to authorize once under the checkpoint-capable deployment; no new callback was observed during a bounded check. Later retries can use the owner endpoint within the original 10-minute window when a checkpoint exists.

### Overnight handoff

- Reference `3202daf9-030b-4e28-a127-3599cc14a012` captured Meta's exact HTTP 400 / code 100 reason: **Unsupported request - method type: get**. POST and versioned-route probes did not resolve it; a native profile read with the retained short token also failed. Experimental request variants and the unhelpful cross-family debug probe are not retained in final code.
- The exact underlying Meta account/app-access cause remains unconfirmed. No Instagram account has been attached to dinosaurio, no expired retry checkpoint is bypassed, and multi-account routing remains disabled.
- Final deployed version: `35a72949-bdcb-4bb9-a148-d23c3db71788`; typecheck and **110 tests** passed. Safe permission/user-ID diagnostics, owner-only native inspection and unsafe-numeric-ID protection are included for the next fresh attempt.
- All old opened invitations and callback codes are one-use. Tomorrow's test must create a fresh invitation; no further emails are sent overnight. Full implementation/setup history, known issues and morning reproduction steps are in `MULTI_ACCOUNT_HANDOFF.md` and the draft PR description.

### Finalization after signing unlock

- Normal signed commits work again; the previously pending final error label, CLI help and handoff/runbook/backlog edits are included in draft PR #6 rather than being left only on the workstation.
- Final branch checks: typecheck, all **110 tests**, owner CLI syntax and diff checks passed. Deployed Worker `d570e04c-a696-498b-9b7b-2759cac20d0d`; multi-account routing and WhatsApp notifications remain disabled.
- Meta's underlying rejection is still unresolved. Next: confirm the exact intended Instagram handle, professional account type and app-access/tester eligibility, then issue one fresh invitation. Reusing an old callback or opened email invitation cannot restart authorization.

### Meta access-review preparation

- Added #15 at the user's request: prepare external-account/advanced access for the two native Instagram business permissions, while validating with an accepted professional tester role.
- `docs/META_APP_REVIEW.md` provides the draft submission packet. The owner screenshot/text shows Ready for testing, not a public-access approval. No Meta request has been submitted yet; the working live demonstration is still a prerequisite to an honest submission.
- Current privacy/deletion pages cover staff connections, encrypted authorization, Gmail send-only invitations and actual retention/deletion behavior. They were deployed and publicly fetched; source signing succeeded on retry as `dc082cb`.
