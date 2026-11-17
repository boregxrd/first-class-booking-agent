# Draft: distribuidora onboarding, calendars, invitations and multi-account routing

## Status at handoff

This is a **draft implementation/review PR, not a declaration that live multi-account Instagram onboarding is finished**.

- **#9 is Finished:** minimal distribuidora database foundation, general DWC profile, calendar association, encrypted account registry and migration verified.
- **#14 remains In progress:** portal/calendar/email onboarding and native Instagram OAuth now pass against real providers after the professional tester invitation was accepted. Live messaging/lifecycle demonstration remains pending.
- **#8 remains In progress:** the general account and dinosaurio's professional account are registered/connected; controlled multi-account routing is enabled, awaiting real DM/booking/calendar acceptance.
- **#15 remains In progress:** public/advanced Meta permission review preparation. The request packet is prepared, but no review has been submitted or approved.
- **#6 remains separate:** actual gym WhatsApp number/templates/notification activation.
- **#10 remains Félix's task:** real TikTok authorization, webhooks and messaging adapter. The registry/interface is prepared; TikTok messaging is not fabricated as working.

The existing bot remains active. Multi-account routing is enabled for the registered active destinations for a controlled live test; WhatsApp notifications remain disabled. Broad public professional-account access still requires the Meta approval tracked in #15.

### Git/signing finalization

The accumulated implementation commits are on `boregxrd/multi-account-foundation`, draft [PR #6](https://github.com/boregxrd/first-class-booking-agent/pull/6). The Mac signing agent initially refused the final commit overnight. After the owner's return, normal signing succeeded without disabling or bypassing signing. The final public-error classification was committed as `b9e59f7`; this branch also includes the previously pending handoff document, runbook/backlog updates and CLI help. No final edits are intentionally left outside the PR.

The earlier pushed snapshot was independently tested with pending edits temporarily stashed, then the branch was rechecked: **typecheck and all 110 tests passed**. The latest controlled-rollout Worker is `16e99117-fe03-4487-8cfb-de5755b3f241`. The historical provider rejection was followed by a successful live authorization after accepting the tester role; diagnostic code alone was not treated as proof of resolution.

## 1. Agreed business model

- All distribuidoras use the same gym context, location, group classes and schedule. Individual calendars attribute prospects; they are not separate teaching schedules.
- Each distribuidora has only name, email, active status, inline calendar ID/viewing link/setup status and internal IDs/timestamps. No `kind`, position, start-date or tier tables.
- Dallas Wellness Club is an ordinary seeded `dwc` profile using the pre-existing general calendar. Its own Instagram/TikTok/WhatsApp connections use the same account registry.
- A profile can own multiple social accounts. Credentials are encrypted separately from public account metadata.
- Bookings retain the originating account, assigned distribuidora and original calendar ID. Changes to account/profile configuration do not silently move an existing booking.
- Scheduled confirmations/reminders use an explicit **gym WhatsApp sender** regardless of the social account that sourced the prospect. Trainer WhatsApp accounts cannot become this sender merely by connecting.

## 2. Database and migration changes

- `0007_distribuidoras.sql`: creates distribuidoras, social accounts, encrypted credentials, gym settings and one-use OAuth state; adds booking attribution; backfills legacy bookings to DWC.
- `0008_connection_invitation_emails.sql`: tracks profile-bound email invitations, recipient, token hash/encrypted-secret reference, 24-hour expiry, Gmail acceptance/rejection/uncertainty and one-use connection-start time.
- Both migrations **have already been applied to the remote D1 database**. Existing customers/bookings and their calendar IDs were preserved.
- The owner-triggered legacy import attaches the old general calendar and encrypts the configured legacy token. It is repeatable, refuses to steal another profile's account, and backfills old-version writes during a staged rollout.
- Additive migrations must remain in place when rolling code back; do not delete credentials, attribution, inbox/outbox rows or deduplication data to troubleshoot.

## 3. Owner portal and authorization

- `/admin` provides profile creation, calendar setup/retry, activation/deactivation, account listing, reconnect/invitation actions, local disconnection and gym reminder-sender selection.
- `/admin/api/*` requires owner authorization. Cloudflare Access support verifies JWT signature, issuer, audience, expiry and owner email allowlist rather than trusting an unsigned email header.
- Current live operator access uses a separate random `ADMIN_API_TOKEN`. Browser token storage is in-memory only; refresh signs the portal out, but does not delete profiles or revoke provider consent.
- Cross-origin mutations are rejected; owner writes require JSON. Listing APIs do not return provider tokens or ciphertext.
- The owner UI distinguishes portal login, Google OAuth configuration, Gmail send authorization and Instagram OAuth configuration, and disables unavailable email actions.
- The portal shell is not itself a customer-data endpoint; seeing it does not grant API access. Invitation recipients do not need owner portal access.

## 4. Credential lifecycle

- AES-256-GCM encryption uses the record ID as authenticated data, random IVs and a separately stored keyring with active key ID.
- Rotation retains old read keys and uses compare-and-set to avoid overwriting concurrent refreshes. Lease fences protect account and refresh writes.
- Google owner tokens refresh using offline authorization. Supported long-lived Instagram tokens renew near expiry; revoked accounts become `needs_authorization` without disabling other accounts.
- Owner CLI setup installs missing secrets without displaying them and refuses to invent replacement encryption keys when an existing remote vault has no matching local backup.
- Sensitive local files are ignored: owner token/key backup, Google OAuth JSON, service-account JSON and local environment files. Their contents are not in the PR.

## 5. Automated Google Calendar onboarding

- Only the **gym Google user** authorizes calendar creation/sharing. Calendars are created through that user's token so the gym is the actual Google `dataOwner`, not the service account.
- Creating a distribuidora provisions her secondary calendar, checkpoints its ID, grants bot service-account `writer`, grants her email `reader`, and requests Google's sharing notification.
- Distribuidoras only open their read-only calendar invitation in their own Google account. They do not grant our app access to personal Google calendars or receive the gym login.
- A unique provisioning marker supports reconciliation after a lost creation response. Ambiguous creation does not blindly create another calendar. Sharing retries reuse the saved calendar and existing ACLs.
- Owner access is not downgraded to reader. A profile email cannot be the bot service account. Repeated profile-create requests use idempotency keys.
- Protected calendar inspection reads actual Google `dataOwner`, public-sharing state and user ACLs rather than assuming ownership from an ACL role alone.

## 6. Instagram connection invitations by email

- Calendar sharing and Instagram connection are **two separate emails**.
- The portal's **Email Instagram connection invitation** action uses the gym's Gmail account and the profile's stored email address. It does not ask the owner to forward an OAuth URL manually.
- Google OAuth now requests `gmail.send`, not inbox read/modify access. The Gmail API was enabled and the gym granted send permission.
- The private invitation is valid for 24 hours. Email preview GETs do not consume it; a deliberate recipient POST starts a fresh 15-minute Instagram OAuth state.
- The callback discovers the authorized account ID, verifies messaging subscription and stores its token/profile mapping. An account already assigned to DWC cannot be silently moved to another distribuidora.
- Gmail acceptance is recorded independently from mailbox delivery. Network uncertainty becomes `unknown`; retries do not blindly resend. Expired email records/secrets have bounded retention/cleanup.
- Existing WhatsApp Cloud API numbers can be connected after Meta provisioning. This is not automatic Business Platform number registration or Embedded Signup.

## 7. Multi-account runtime

- Signed incoming webhooks use the receiving platform account ID to resolve the active social account, distribuidora and calendar. Unknown/inactive/expired destinations do not fall back to another profile.
- Each processed message gets scoped credentials and a scoped booking service while gym rules/context stay shared. Conversation history remains channel/account/sender-specific.
- Profile reads and text replies use the contacted account's credentials; replies go out from that account.
- New routed bookings atomically prevent an already-active contact from creating another attributed booking. The existing gym-wide 30-day trial eligibility logic from Félix is preserved.
- Booking retries, reschedules, cancellations and calendar recovery use the calendar ID saved on the booking—even after account disconnect or profile reconfiguration.
- Calendar health alert IDs include calendar and event identity. Calendar reconciliation is bounded and cursor-based.
- Notification validation follows the booking's trainer calendar, but sending uses the explicitly selected gym WhatsApp account. Optional approved four-parameter templates include original-account attribution; old three-parameter templates stay supported while the flag is off.

## 8. Automated verification

Latest checks:

- `npm run typecheck` — passed.
- `npx tsx --test --test-reporter=dot src/llm-integration/tests/*.test.ts src/calendar/*.test.ts src/bookings/*.test.ts` — **110 tests passed**.
- `node --check scripts/owner.mjs` — passed.
- Worker dry-run/deployed builds — passed.
- `git diff --check` — passed; private credential files are not tracked.

Coverage includes real local D1 migration/backfill, account isolation, encryption/rotation, valid owner JWTs and rejected invalid audiences, OAuth replay protection, ambiguous calendar creation, idempotent profile creation, scanner-safe invitations, Gmail uncertain delivery, token checkpoint expiry and ownership-conflict handling.

`multi-account-pipeline.test.ts` exercises **signed webhook → durable inbox → production queue handler/factory/agent → booking approval → Google Calendar client → outbox/Meta sender**, for **two distribuidoras plus the general DWC account**. It checks independent calendars, stored attribution, no booking before approval and correct reply credentials/recipient. Incorrect legacy credentials make accidental fallback fail. External network/queue infrastructure is simulated: this is not a claim of three live provider connections.

## 9. Live operations already performed

- Installed the owner's private portal token and encryption key without printing them; imported the existing DWC calendar/Instagram token without recreating the general calendar.
- Configured the Google OAuth Web client from its ignored downloaded JSON; verified callback URI; added gym Google as a test user after the initial testing-mode 403; completed gym consent.
- Created the owner-requested **dinosaurio** profile and real **DWC — dinosaurio** calendar.
- Read real Google metadata/ACLs: the gym is the actual `dataOwner`; bot is writer; selected recipient is reader; calendar is not public. The general calendar's gym data ownership was also verified.
- Confirmed a repeat creation request reuses the same profile/calendar rather than creating another or requesting another sharing invitation.
- Enabled Gmail API, completed send-only consent and obtained real Gmail acceptance for Instagram invitation emails. The recipient reached Meta authorization/callback using an emailed invitation.
- Installed the user-confirmed Instagram Login app ID and matching secret through stdin; the secret was not printed or committed.
- Protected overview was verified: unauthenticated API returns 401, authenticated overview succeeds, public health returns 200.
- After accepting the professional test account's Instagram Tester invitation, a fresh native authorization completed token exchange, Graph identity, `messages` subscription and encrypted account registration. It is connected to dinosaurio's existing calendar, with actual long-token expiry `2027-01-16T09:53:14.205Z`. Earlier profile-scoped callback failure alerts were resolved after this success; diagnostics are retained.

Actual deployment settings remain:

```text
META_MESSAGING_MODE=live
MULTI_ACCOUNT_ENABLED=true
WHATSAPP_NOTIFICATIONS_ENABLED=false
WHATSAPP_ATTRIBUTION_TEMPLATES=false
```

## 10. Historical Instagram rejection and the successful tester-role retest

The first generic callback error was **not expiry**: the state was consumed about seven seconds after starting. Diagnostics then isolated a successful initial authorization-code exchange followed by:

```text
stage: long_token
HTTP: 400
Meta code: 100
provider reason: Unsupported request - method type: get
reference: 3202daf9-030b-4e28-a127-3599cc14a012
```

Within the authorized checkpoint window, owner-side retries tested POST and versioned OAuth route variants. Meta rejected them too; a native short-token profile read also returned unsupported GET. Method changes did **not** fix the provider failure. Experimental variants and an unhelpful cross-family debug probe were removed. Final code retains the native Instagram exchange endpoint with an explicit serialized GET request, not a guessed Facebook Login fallback.

**Update 2026-11-17:** the account holder confirmed that the professional account's separate Instagram Tester invitation had not been accepted. After accepting it and opening a fresh connection email, the same native flow succeeded, including the previously rejected long-token and identity steps. Dinosaurio now has a connected professional account. Granting both OAuth scopes was not sufficient while the tester role was pending. This successful controlled test does not grant approved public access for unrelated professional accounts.

To make the next attempt useful, the callback now captures provider-reported known permissions and a safely represented short-token user ID as diagnostics only. Explicitly missing requested permissions fail early. Unknown scope strings are not logged, unsafe numeric account IDs are not silently rounded, and actual account binding still requires a successful Graph identity lookup and messaging subscription.

Safe diagnostics persist stage, codes and bounded credential-redacted summaries. OAuth codes, access tokens and app secrets are not returned to the browser or retained in diagnostic text. Failed post-token operations may retain a profile-bound encrypted checkpoint for an owner-only **10-minute** retry window. The original deadline is not extended; purge is bounded after 15 minutes. No expired checkpoint is bypassed. Ownership conflicts never reassign the original account.

The old callbacks/codes and emailed invitations already opened during these tests are one-use and cannot be refreshed into a new authorization. Existing diagnostic references are historical; their checkpoints have expired. Do not treat the old Unsupported request as the current connection status or revoke the successful connection just to clear that historical message.

## 11. Next live test

1. Controlled routing is already enabled for the registered active accounts. Keep WhatsApp sending off during this test.
2. From a different prospect Instagram account, DM the professional account connected to dinosaurio. Self/echo messages are ignored intentionally. Verify that the bot replies from the contacted account.
3. Select an explicit future Dallas day/hour, supply/confirm the test booking name and phone, and approve the saved summary. Verify that the event/roster appears in **DWC — dinosaurio**, not the general calendar. A known existing active contact may correctly be blocked as a duplicate rather than silently transferred.
4. Send a separate message to the existing general account and verify its destination remains the general calendar. Then test reschedule/cancel, disconnect isolation, and explicit reconnect with the same profile/calendar.
5. No new OAuth email is needed for ordinary DMs. If a deliberate reconnect is required, generate one fresh invitation. Do not refresh an already-used callback or reuse an opened one-use invitation. If authorization fails, capture the new reference immediately. Within its window, the owner can use:
   ```sh
   node scripts/owner.mjs --inspect-instagram <new-reference>
   node scripts/owner.mjs --retry-instagram <new-reference>
   ```
   Inspection returns only safe metadata and does not connect the account or extend the window. Retry resumes only supported steps using the encrypted token; it never replays the login code.
6. Record real DM/approval/calendar/reply and lifecycle evidence before marking #8/#14 finished. Local simulated-provider tests are not substituted for that evidence.
7. Enable real WhatsApp reminders only after #6 and template approval. Arbitrary external-account onboarding needs #15; TikTok remains #10. Disable multi-account routing if the controlled live test reveals an isolation/routing issue, preserving saved attribution and calendar IDs.

## Review and rollout notes

- `docs/MULTI_ACCOUNT_PLAN.md` contains the acceptance checklist and dated verification records.
- `docs/OWNER_PORTAL.md` contains owner/Google/Meta setup, credential rotation, provisioning recovery and diagnostic commands.
- `jira-backlog.md` intentionally leaves #14 and #8 in progress. An email accepted by Gmail, a passing mock integration test or a generated short token is not treated as a finished live Instagram connection.
- Commits are intentionally focused by schema, repository, authorization, crypto, Google transport, provisioning, portal, routing, email, tests and documentation so individual pieces remain discoverable.
- This PR should remain **draft/unmerged** until the remaining live acceptance is understood. Production has the additive schema, owner tooling and controlled registered-account routing deployed from the feature branch; public account approval and WhatsApp sending remain gated separately.

## 12. Meta public-access review preparation (#15)

- The owner-provided dashboard shows the two native business permissions as **Ready for testing**, each with 0 API calls. The app is Published, but that is not proof of approved access for externally owned accounts.
- The user agreed to prepare Meta review in parallel with testing through an explicitly accepted Instagram Tester role. Only `instagram_business_basic` and `instagram_business_manage_messages` are planned for this request; unrelated ads, content publishing, insights, comments and Human Agent scopes are not requested merely because the catalog lists them.
- `docs/META_APP_REVIEW.md` contains draft purpose text, permission justifications, actual processor disclosures, stable reviewer-access considerations, screencast steps and a submission checklist. It is also preserved in the earlier [PR preparation comment](https://github.com/boregxrd/first-class-booking-agent/pull/6#issuecomment-6944248429).
- Updated public privacy/deletion copy to describe actual staff profile/account credentials, owner-only Google authorization, reader calendars, send-only Gmail invitations, temporary checkpoint/email retention and manual account-data deletion. Deployed `5ac727f1-02f1-44ba-805e-6a56a3451ca3` and fetched both public pages successfully. This changes disclosures, not OAuth token behavior or activation flags.
- A transient SSH signing-socket failure delayed these follow-up commits. Normal signing succeeded on retry (`dc082cb` for policy source); signing was not disabled and the prepared files are now part of this branch.
- **No Meta review has been submitted.** Tester role acceptance and native OAuth are now verified; the real message/booking demonstration, appropriate reviewer access, and any remaining dashboard prerequisites are still pending. Do not submit production owner credentials or a one-use expiring invitation as the sole reviewer entry point.
- The latest dinosaurio invitation has now led to an actual successful callback after tester acceptance, verified in the registry with a saved long-token expiry. Ordinary DM testing needs no further OAuth email. Public access and live booking acceptance are still separate gates.
