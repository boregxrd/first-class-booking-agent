# Meta external-account access: review preparation (#15)

## Current status — 2026-11-17

- The app is Published, but the owner-provided permission screen shows `instagram_business_basic` and `instagram_business_manage_messages` as **Ready for testing**, each with 0 API calls. That does not demonstrate approved public/advanced access.
- The role screen showed the existing gym test account as Instagram Tester and another invitation pending. The new professional test account must be invited and accept its role before the controlled test.
- The user agreed to prepare public-account approval in parallel with tester-based validation. **This document is a draft submission packet, not a submitted or approved request.**
- Native Instagram OAuth still fails at long-token exchange and a short-token Graph profile read with HTTP 400 / Meta code 100, Unsupported request. Tester restrictions are a hypothesis to check, not a verified cause. Keep #14 and #8 in progress.
- Public privacy/deletion copy was updated for staff profiles, encrypted account authorization, calendar sharing, Gmail send-only invitations and actual retention/manual deletion behavior. TypeScript/build checks passed; deployment `5ac727f1-02f1-44ba-805e-6a56a3451ca3` was fetched publicly and verified. Messaging logic and activation flags are unchanged.
- Git follow-up: normal signing succeeded on the owner's retry; public-policy source was committed as `dc082cb`. This packet and the backlog are included in the feature branch as well as the earlier PR #6 preparation comment. Signing was not disabled. Meta submission is still pending the working demonstration and owner dashboard requirements.

## Request only the permissions actually used

| Permission | Implemented purpose and demonstration |
|---|---|
| `instagram_business_basic` | Identify the professional account that explicitly authorizes Instagram Login, read its provider ID/username, and associate incoming account traffic with the correct distribuidora/calendar. Show the professional account's own consent and the resulting account mapping. |
| `instagram_business_manage_messages` | Receive user-initiated Instagram DMs through verified messaging webhooks, retrieve permitted messaging-context profile fields, and reply from the contacted professional account with gym information and confirmed booking results. Show a real incoming message, reply and explicit booking approval. |

Do not request ads, publishing, insights, comments, page administration or Human Agent access for this review merely because they appear in the use-case catalog. The bot does not use a Human Agent tag to extend automated conversations beyond the normal Instagram text window. Request any additional feature only if a real endpoint/dashboard requirement establishes a necessary use and we can demonstrate it.

Public onboarding for professional accounts outside the app's roles/assets requires the access level and review approval Meta specifies for these permissions, commonly Advanced Access. Publication alone does not grant it. Standard access may suffice for owned/managed or explicitly permitted test accounts; the dashboard is the authority for this app's exact requirements.

## Draft use-case explanations

Use these descriptions only after the corresponding live flow is demonstrated; do not claim the failing OAuth flow already works.

### Application purpose

Dallas Wellness Club's First-Class Booking Agent helps prospective gym customers ask questions and arrange a free trial class through Instagram Direct. The gym and its authorized distribuidoras explicitly connect eligible professional Instagram accounts using Instagram Login. The same gym information and class schedule are used across accounts. The account a customer contacts determines the booking's attribution and gym-owned calendar. No prospect needs to grant Instagram Login to send a DM.

### `instagram_business_basic`

We use this permission to identify the professional Instagram account after its owner explicitly authorizes our app. Its provider account ID and username are associated with the owner's registered distribuidora profile and gym-owned calendar. This lets us process the correct receiving account and prevents another distribuidora's credentials or calendar from being used. Provider credentials are encrypted and access to configuration is restricted to the gym's authorized operators. We do not request this permission to browse unrelated profiles or publish content.

### `instagram_business_manage_messages`

We use this permission to receive messages initiated by customers to a connected professional Instagram account and reply from that same account. The assistant answers questions about the gym and prepares a trial-class booking only after the customer supplies the required name, day, time and contact details. The application requires explicit customer confirmation before creating/changing/cancelling a booking. Instagram text replies are restricted to the permitted messaging window. Scheduled reminders, when separately configured and consented to, use the gym's WhatsApp account rather than an Instagram Human Agent exception. The application does not perform unsolicited Instagram marketing.

### Data processors and privacy answers

Disclose the actual processing rather than claiming no third parties: Cloudflare hosts the app/database/queues; OpenAI processes bounded conversation context for AI-assisted replies; Google Calendar holds authorized class rosters; gym Gmail sends staff connection invitations after owner send-only consent. Stored provider credentials and OAuth codes are not passed as application data to the language model. API requests use `store:false`, but do not claim that this eliminates all provider processing, security logs or retention obligations.

## Existing public app information

- Privacy: https://first-class-booking-agent.dallaswellnessclubweb.workers.dev/privacy
- Data deletion instructions: https://first-class-booking-agent.dallaswellnessclubweb.workers.dev/data-deletion
- Contact: dallaswellnessclubweb@gmail.com
- Instagram OAuth callback: https://first-class-booking-agent.dallaswellnessclubweb.workers.dev/connections/callback/instagram
- Messaging webhook: https://first-class-booking-agent.dallaswellnessclubweb.workers.dev/webhook

Privacy and deletion pages were fetched publicly during preparation. Data deletion is an owner-operated email request workflow, not an implemented Meta deletion callback. Select Meta's deletion-instructions URL option where offered. The published policy must cover current multi-account profile/credential handling and staff invitation emails, not only the original single-account chat.

## Parallel tracks

### A. Controlled test now

1. Add the intended professional test account under **App roles → Roles → Add People → Instagram Tester**, using the same app's Instagram Tester role, not only a generic app test user.
2. The account holder accepts from Instagram's **Apps and websites → Tester invites** (menu labels may vary).
3. Confirm the role is accepted, not Pending. Business/Creator conversion alone does not establish an app role or approved external access.
4. Generate one fresh emailed connection invitation. Previously opened invitations and used callback codes cannot be reused.
5. Complete native OAuth, inspect actual granted permissions and the account ID, and verify the messaging subscription. If it fails, capture the new diagnostic reference; owner-only checkpoint retry/inspection is limited to its original 10-minute window.
6. Once the account is actually connected, run the controlled multi-account DM → explicit approval → correct calendar → same-account reply test. Do not activate all accounts or claim completion just because a short token was issued.

### B. Public-access request preparation now

1. In **Use cases → Instagram API**, inspect the Action area for the two requested permissions. Follow **Request review / Request advanced access / Add to review** as that dashboard exposes them. If unavailable, inspect **Testing** and the app's publication/review requirements for missing test calls or other prerequisites.
2. Record Meta's exact outstanding requirements. Complete business verification, app information or data-handling questions only if requested; use the gym owner's real legal/business information, not invented details.
3. Save a review draft and the two purpose explanations. `Ready for testing` and 0 calls are not successful review evidence. If Meta requires successful test calls, the controlled test provides them; allow the dashboard's usage counters time to update.
4. Record a functional demonstration after #14's native OAuth/messaging problem is resolved. Do not submit a video that stops at Unsupported request or describe simulated-provider tests as live functionality.
5. Provide a stable, reproducible reviewer testing path appropriate to Meta's form. A private one-use 24-hour email link must not be the sole review entry point because it may expire before review. Determine whether reviewer-provided accounts, an approved dedicated test account or an isolated demo environment is needed. Do not provide the production owner token, gym Google credentials or access to real customer rosters as reviewer credentials.
6. Submit using the app owner's Meta dashboard only when required evidence and reviewer access are ready. Record the submission ID, permissions, submission date and Meta's response here; no submission has been made yet.

## Screencast plan (pending successful live flow)

1. Show the gym/distribuidora use case and the relevant professional Instagram account, using dedicated synthetic prospects/reviewer assets.
2. Owner creates/selects a demo distribuidora and starts an emailed invitation. Show the separate calendar-sharing and Instagram-connection purposes without exposing owner tokens or app secrets.
3. Holder opens the invitation, deliberately starts Instagram Login and grants the two requested permissions.
4. Show the resulting professional account ID/username mapping and correct assigned calendar, with credentials hidden.
5. A separate prospect sends an actual DM; show the bot replying from the contacted account and answering gym/schedule questions.
6. Prospect selects both a day and time and supplies/acknowledges the booking name and contact. Show explicit confirmation before the actual Calendar write and the verified confirmation reply afterward.
7. Show another account using its own calendar, and that cancellations/recovery preserve the original attribution.
8. Show disconnect/opt-out and public privacy/deletion instructions. Do not promise WhatsApp delivery in the demonstration unless #6, consent and approved templates are actually enabled and verified.

## Submission checklist

- [ ] Professional tester role accepted.
- [ ] Native login, identity, subscription and real DM/reply work.
- [ ] Correct-calendar booking and cancellation verified live.
- [ ] Actual access levels and dashboard prerequisites recorded.
- [ ] App/business information and any requested verification complete.
- [x] Current privacy/deletion URLs publicly reachable and consistent with implementation.
- [ ] Functional screencast recorded with secrets/customer data excluded.
- [ ] Stable reviewer instructions/access path prepared and checked.
- [ ] Request submitted for the required two Instagram business permissions.
- [ ] Meta approval recorded; reconnect externally owned accounts and validate before broad rollout.

Approval is controlled by Meta. Adding testers is a pilot/testing step, not the intended permanent onboarding workflow for every distribuidora, and it is not represented as a proven fix for the current token rejection.
