# Draft: distribuidora onboarding, calendars, invitations and multi-account routing

## Status at handoff

This is a **draft implementation/review PR, not a declaration that live multi-account Instagram onboarding is finished**.

- **#9 is Finished:** minimal distribuidora database foundation, general DWC profile, calendar association, encrypted account registry and migration verified.
- **#14 remains In progress:** portal/calendar/email onboarding works against real Google; Instagram authorization fails at the provider API stage.
- **#8 remains In progress:** full application pipeline passes automated integration tests, but two real connected Instagram accounts have not passed live booking acceptance.
- **#6 remains separate:** actual gym WhatsApp number/templates/notification activation.
- **#10 remains Félix's task:** real TikTok authorization, webhooks and messaging adapter. The registry/interface is prepared; TikTok messaging is not fabricated as working.

The existing single-account bot remains active. Multi-account routing and WhatsApp notifications are disabled while onboarding is validated.

### Git/signing finalization

The accumulated implementation commits are on `boregxrd/multi-account-foundation`, draft [PR #6](https://github.com/boregxrd/first-class-booking-agent/pull/6). The Mac signing agent initially refused the final commit overnight. After the owner's return, normal signing succeeded without disabling or bypassing signing. The final public-error classification was committed as `b9e59f7`; this branch also includes the previously pending handoff document, runbook/backlog updates and CLI help. No final edits are intentionally left outside the PR.

The earlier pushed snapshot was independently tested with pending edits temporarily stashed, then the final branch was rechecked: **typecheck and all 110 tests passed**. The finalized deployed Worker is `d570e04c-a696-498b-9b7b-2759cac20d0d`, including grant/ID validation, private checkpoint inspection and the clearer unsupported-request label. This improves diagnostics; it is **not** a verified fix for the underlying Meta rejection.

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

Actual deployment settings remain:

```text
META_MESSAGING_MODE=live
MULTI_ACCOUNT_ENABLED=false
WHATSAPP_NOTIFICATIONS_ENABLED=false
WHATSAPP_ATTRIBUTION_TEMPLATES=false
```

## 10. Unresolved Instagram rejection — do not lose this context

The first generic callback error was **not expiry**: the state was consumed about seven seconds after starting. Diagnostics then isolated a successful initial authorization-code exchange followed by:

```text
stage: long_token
HTTP: 400
Meta code: 100
provider reason: Unsupported request - method type: get
reference: 3202daf9-030b-4e28-a127-3599cc14a012
```

Within the authorized checkpoint window, owner-side retries tested POST and versioned OAuth route variants. Meta rejected them too; a native short-token profile read also returned unsupported GET. Method changes did **not** fix the provider failure. Experimental variants and an unhelpful cross-family debug probe were removed. Final code retains the native Instagram exchange endpoint with an explicit serialized GET request, not a guessed Facebook Login fallback.

**The precise underlying Meta account/app-access cause remains unconfirmed. Dinosaurio has no connected Instagram account yet.** The selected Instagram handle/professional-account eligibility and the app's required permission/tester/public-access state still need confirmation.

To make the next attempt useful, the callback now captures provider-reported known permissions and a safely represented short-token user ID as diagnostics only. Explicitly missing requested permissions fail early. Unknown scope strings are not logged, unsafe numeric account IDs are not silently rounded, and actual account binding still requires a successful Graph identity lookup and messaging subscription.

Safe diagnostics persist stage, codes and bounded credential-redacted summaries. OAuth codes, access tokens and app secrets are not returned to the browser or retained in diagnostic text. Failed post-token operations may retain a profile-bound encrypted checkpoint for an owner-only **10-minute** retry window. The original deadline is not extended; purge is bounded after 15 minutes. No expired checkpoint is bypassed. Ownership conflicts never reassign the original account.

The old callbacks/codes and emailed invitations already opened during these tests are one-use and cannot be refreshed into a new authorization. Existing diagnostic references are historical; their checkpoints have expired.

## 11. Next live test

1. Keep multi-account routing off.
2. Confirm the intended professional Instagram account is different from the account already assigned to DWC, and is eligible for the Meta app's current permissions/tester roles or approved public messaging access.
3. Generate **one new email invitation** from dinosaurio's portal card. On the owner's Mac, portal login can use `node scripts/owner.mjs --copy-token`, then paste into **Operator token** and **Load portal**. The equivalent email command is:
   ```sh
   node scripts/owner.mjs --email-instagram babf97b6-c023-46e0-aa90-96f4f592d00d
   ```
4. Open the newest email and deliberately start Instagram authorization. Do not refresh an already-used callback or reuse an opened one-use invitation.
5. If it fails, capture the new diagnostic reference immediately. Within its window, the owner can use:
   ```sh
   node scripts/owner.mjs --inspect-instagram <new-reference>
   node scripts/owner.mjs --retry-instagram <new-reference>
   ```
   Inspection returns only safe metadata and does not connect the account or extend the window. Retry resumes only supported steps using the encrypted token; it never replays the login code.
6. If it succeeds, verify actual account ID, profile/calendar mapping, expiry and messaging subscription before testing a real DM → approval → calendar event → reply.
7. Only activate multi-account routing once the general account and the new trainer account both pass live tests. Enable real WhatsApp reminders only after #6 and template approval. TikTok remains #10.

## Review and rollout notes

- `docs/MULTI_ACCOUNT_PLAN.md` contains the acceptance checklist and dated verification records.
- `docs/OWNER_PORTAL.md` contains owner/Google/Meta setup, credential rotation, provisioning recovery and diagnostic commands.
- `jira-backlog.md` intentionally leaves #14 and #8 in progress. An email accepted by Gmail, a passing mock integration test or a generated short token is not treated as a finished live Instagram connection.
- Commits are intentionally focused by schema, repository, authorization, crypto, Google transport, provisioning, portal, routing, email, tests and documentation so individual pieces remain discoverable.
- This PR should remain **draft/unmerged** until the remaining live acceptance is understood. Production already has the additive schema and owner tooling deployed from the feature branch with multi-account activation gated off.
