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

- [ ] Creating a distribuidora creates her gym-owned calendar, grants bot writer access and her reader access, and requests sharing email notification.
- [ ] Failed setup resumes without blindly creating duplicate calendars.
- [ ] Accounts connect, reconnect and disconnect through owner-authorized flows; tokens never appear in responses/logs.
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
