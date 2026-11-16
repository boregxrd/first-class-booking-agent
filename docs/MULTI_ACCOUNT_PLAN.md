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
