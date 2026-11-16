# Owner portal and multi-account rollout

## What is implemented

`/admin` is a management shell. Every `/admin/api/*` request requires verified owner authorization. It supports profile creation, automatic calendar provisioning, setup retry, active/inactive status, expiring Instagram invitations, existing WhatsApp Cloud API number connection, local account disconnection, and explicit gym reminder-sender selection. No credentials appear in list APIs. Public OAuth callbacks validate expiring one-use state; Google uses PKCE and validates the configured gym email.

The current production single-account integration stays unchanged until `MULTI_ACCOUNT_ENABLED=true`. Apply migrations through `0008_connection_invitation_emails.sql` **before deploying this code**, even when multi-account mode is off: booking writes and owner/maintenance queries use the new schema. Existing bookings are assigned to the seeded normal `dwc` profile. Existing calendars are never recreated by the import.

## 1. Protect owner access

Create a Cloudflare Access self-hosted application covering `/admin` and `/admin/*`, allowing only the owner's emails. Set:

- `ADMIN_ORIGIN`: exact HTTPS origin of the deployed Worker; no path/query.
- `ACCESS_TEAM_DOMAIN`: e.g. `your-team.cloudflareaccess.com`.
- `ACCESS_AUD`: Access application's audience ID.
- `OWNER_EMAILS`: comma-separated allowed owner email addresses.

The Worker verifies the Access JWT signature, issuer, audience, expiry and owner email. It never trusts a standalone authenticated-email header. Browser mutations require the same origin and JSON. Leave `/connections/callback/google` and `/connections/callback/instagram` outside Access: the account holder returns there with the single-use authorization state.

For terminal or emergency use, install a **distinct**, random `ADMIN_API_TOKEN` of at least 32 characters as a Worker secret. The portal's password field can use it in memory; it is not saved to browser storage. Do not reuse `DIRECT_CHAT_TOKEN` or a Meta access token. A publicly reachable portal shell contains no customer data; its APIs remain protected even if Access is not configured.

On the owner's Mac, `node scripts/owner.mjs --copy-token` copies only the operator token from the private backup to the clipboard without printing it or copying the encryption key. Paste into **Operator token** and click **Load portal**. The profile cards, including their **Connect Instagram / create invitation** buttons, load only after authentication. Refreshing/reopening the page clears the in-memory operator login; it does not revoke saved Google consent or delete any profiles/calendars. Do not recreate a profile just because its card is hidden in the signed-out view.

## 2. Install the credential vault

For this repository's configured Worker, `node scripts/owner.mjs --setup` installs missing owner/vault secrets and creates an ignored, mode-0600 `.owner-credentials.json` backup without printing secrets. It refuses to create new encryption material when remote secrets already exist without a local backup, and never overwrites existing remote secrets. Back up that file securely. `--status` loads the protected overview, `--bootstrap` imports the existing gym, and `--google` prints an expiring owner authorization link once the Google client is configured. To use the portal without Access, take the `adminToken` from that private local file and enter it in the password field; do not paste it in chat or a URL.

Generate a random 32-byte encryption key outside the repository. Install `ACCOUNT_CREDENTIAL_KEYS` as a Worker secret containing JSON, e.g. `{"v1":"<base64-encoded 32 random bytes>"}`. Set `ACCOUNT_CREDENTIAL_ACTIVE_KEY=v1`.

Tokens are encrypted using AES-256-GCM with the credential record ID as authenticated data. For rotation, first deploy a keyring containing old and new keys with the old active ID, and retire versions lacking the new key. Then switch the active ID. Call owner-authorized `POST /admin/api/rotate-credentials` with `{"after":""}`; repeat with the returned `nextCursor` until `rotated` is zero. Rotation uses compare-and-set so it cannot overwrite a concurrent refresh. Keep old keys until every row is rotated and old deployments are retired; update the secure backup during rotation.

## 3. Authorize only the gym Google user

Enable Google Calendar API and create a Google OAuth **Web application** client in the gym-controlled project. Register exactly:

`https://<worker-host>/connections/callback/google`

Set `GOOGLE_OAUTH_CLIENT_ID`, secret `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OWNER_EMAIL=dallaswellnessclubweb@gmail.com`. Allow this user on the consent screen while testing; Google testing-mode refresh-token restrictions may require reauthorization. Configure the consent application's publication/verification appropriate to deployment.

You can install the client without copying its secret into chat or shell arguments: download Google's **Web application** client JSON, save it as the ignored `google-oauth-client.json` in the repository root, and run `node scripts/owner.mjs --google-client google-oauth-client.json`. The importer validates the exact callback URI and passes the client ID/secret to Wrangler through stdin without printing them. A service-account key or Desktop application client is rejected. The portal disables Google authorization until owner login succeeds and the Google client is configured; its overview exposes only a boolean setup status, never credential values.

After consent, `node scripts/owner.mjs --create-profile "Name" email@example.com` runs the same calendar creation flow as the portal. It prints a public request ID before sending: pass that ID as the final argument when retrying a lost response, rather than creating a second profile. `--provision <profile-id>` resumes setup, and `--inspect-calendar <profile-id>` reads actual Google `dataOwner`, sharing roles and public-sharing status through the protected API without exposing OAuth credentials.

From `/admin`, choose **Authorize gym Google: calendars and invitation emails**, open the returned link and consent as that exact gym user. The request needs OpenID/email, `calendar.calendars`, `calendar.calendarlist.readonly` (ambiguous-create recovery), `calendar.acls`, `calendar.events`, and **`gmail.send`** for account-connection invitation emails. No inbox-reading scope is requested. Existing calendar-only consent remains usable for calendars, but the gym must reauthorize with Gmail send permission before emailing connection invitations. No distribuidora authorizes personal Google/Gmail access to this app.

Keep `GOOGLE_CLIENT_EMAIL`/secret `GOOGLE_PRIVATE_KEY` for the existing bot service account. New calendars are created using the **gym user's** token, then shared with the service account as writer and the distribuidora as reader. Google sends the reader sharing notification. The gym account remains the data owner. If the profile email is the gym owner itself, owner access is retained rather than downgraded. Profile emails cannot equal the bot service account.

Creation writes a unique provisioning marker into the calendar description and checkpoints each step. Lost responses leave `creating`/`creation_unknown`; retry searches the gym's owned calendar list for that marker. If none is visible, creation remains blocked for owner/operator reconciliation; do not reset the state or create another blindly. A sharing retry reuses the saved calendar and existing ACLs rather than sending duplicate invitations. Calendar links do not grant access themselves.

## 4. Import the existing gym account

Use **Import existing gym configuration** (owner-authorized `POST /admin/api/bootstrap`, `{}`). It attaches `GOOGLE_CALENDAR_ID` to the seeded `dwc` profile and encrypts existing Instagram/WhatsApp tokens into the registry. It refuses to steal a social account from another profile. The old token variables remain as rollback configuration.

The gym is an ordinary profile: no `kind`, position or tier. `general_distribuidora_id` references it, and `reminder_sender_account_id` references its selected WhatsApp connection. Optional trainer WhatsApp accounts cannot be selected as the central reminder sender. Disconnecting an account is local; revoke provider-side authorization in the provider dashboard if required. Deactivating a profile stops new routing; it does not delete its historical bookings/calendars.

## 5. Instagram account invitations

Set `INSTAGRAM_OAUTH_CLIENT_ID` and secret `INSTAGRAM_OAUTH_CLIENT_SECRET` for the **Instagram Login** application; do not assume the parent Facebook application's secret is interchangeable. Register exactly:

`https://<worker-host>/connections/callback/instagram`

Keep the verified Meta callback `/webhook`, matching `META_APP_SECRET`, configured once for the application. Each account holder needs an eligible professional account, required messaging access/app review, and must authorize `instagram_business_basic` and `instagram_business_manage_messages`.

Create a profile (its calendar is provisioned automatically after Google authorization), then choose **Email Instagram connection invitation**. The gym sends a separate email from its Gmail account to the profile's stored email address. This is different from Google's calendar-sharing invitation. Enable the **Gmail API in the OAuth client's Cloud project** and reauthorize gym Google with `gmail.send`; no new Google client or email vendor is needed. Meta OAuth configuration must also be complete before emails can be sent.

The emailed link is valid for **24 hours**. Opening it shows a recipient page without consuming the invitation, so email security previews do not invalidate it. The recipient deliberately presses **Conectar Instagram** to consume the invitation and start a fresh **15-minute** Instagram authorization. The callback exchanges the token, obtains the actual `user_id`/username, subscribes that account's `messages` webhook, and only then saves it connected. Accounts already assigned elsewhere require explicit owner resolution rather than silent transfer. Long-lived Instagram tokens renew when within seven days of expiry; revoked accounts become `needs_authorization` without disconnecting other accounts. Reconnect through a fresh emailed invitation.

Each email request has an idempotency key. Gmail acceptance is recorded separately from actual receipt; ambiguous network outcomes remain `unknown` and never blindly resend. The portal displays acceptance, rejection, uncertainty and whether connection has started. Check with the recipient before deliberately sending another email after an unknown outcome. The private invitation token is stored encrypted, and only its hash is used for public-link lookup; owner listing APIs never return that token. Expired invitation records/secrets are cleaned after 90 days, and expired in-flight sends become unknown.

Operators can use `node scripts/owner.mjs --email-instagram <profile-id> [request-id]` to run this same email flow. Reuse the printed request ID when retrying a lost response. A Gmail rejection is different from an ambiguous send; no invitation should be reported as delivered based only on Gmail acceptance.

If an imported legacy token has no recorded expiry, reconnect it through this flow before multi-account activation so renewal can use the provider's actual expiry rather than an invented date.

### Owner and distribuidora journey

1. The gym owner authorizes the gym Google account once and creates a distribuidora profile.
2. The app creates/shares its calendar. The distribuidora opens the invitation using her own Google account; she does **not** grant our app management access to her personal Google calendars or need owner portal access.
3. The owner selects **Email Instagram connection invitation** on that profile; the gym emails its registered address. The account holder opens the 24-hour invitation and presses **Conectar Instagram**.
4. The holder signs into her eligible professional Instagram account and grants messaging access. The server discovers the actual account ID, subscribes its messaging webhook and saves the encrypted credentials/mapping to the existing profile/calendar.
5. After real-account acceptance and activation, a DM to that Instagram account uses the same gym bot/context as DWC, replies from that account and attributes bookings to its distribuidora calendar. Scheduled reminders remain on the gym WhatsApp account.

The Meta OAuth application ID/secret and callback, Gmail API, and gym Gmail send consent must be configured before step 3 can work. Calendar provisioning alone does not connect Instagram, and the account registry is not used for new trainer traffic while `MULTI_ACCOUNT_ENABLED=false`.

## 6. WhatsApp, TikTok and reminder templates

- **WhatsApp:** the portal connects an **existing provisioned Cloud API phone-number ID** and an access token. It verifies number metadata with Meta and stores the token encrypted. Owning the WhatsApp Business mobile app alone is not sufficient. New-number Business Platform signup, ownership verification, app/WABA webhook subscription, eligibility and template approval must be completed in Meta first; this is not a fabricated Embedded Signup flow. Gym activation/delivery remains task #6.
- **TikTok:** the registry and `MessagingConnectionAdapter`/`saveMessagingConnection` provide an integration boundary for Félix's task #10. TikTok OAuth/messaging endpoints and entitlements are not implemented or falsely displayed as connected. Félix must add provider authorization/verification, webhook normalization, channel dispatch and refresh semantics once API access is established.
- **Central reminders:** select the gym's connected WhatsApp account. Scheduled notifications always use it; normal chat replies use the account contacted. Calendar checks follow each booking's saved calendar ID.
- Keep `WHATSAPP_ATTRIBUTION_TEMPLATES=false` for the existing three-parameter templates. After approval of templates with **name, date, time, originating account** in that order, set the approved template names and enable `WHATSAPP_ATTRIBUTION_TEMPLATES=true`. The source is snapshotted on the booking. Notification sending still requires consent, `WHATSAPP_NOTIFICATIONS_ENABLED=true`, and the mode/test allowlist.

## 7. Verify and activate

Run `npm run typecheck` and `npm test`, then the two-account checklist in `MULTI_ACCOUNT_PLAN.md`. Verify actual Google ownership/sharing/invitation, two real Instagram accounts, provider permission scopes, and central WhatsApp delivery with approved templates. Set `MULTI_ACCOUNT_ENABLED=true` only once the registry, credentials and calendars are ready. Unknown, inactive or expired destinations never fall back to another trainer.

Background booking recovery resolves the calendar saved on the booking, even if the original social account is disconnected. Calendar scans are bounded and cursor-based. Replies/history remain scoped to channel/account/sender. New routed bookings atomically reject an already-active contact instead of moving attribution; the existing gym-wide 30-day trial check remains in place. Matching contact details prevents duplicate booking but does not automatically merge conversations or reveal another customer's history.

If activation fails, disable multi-account mode to resume the original account configuration and inspect per-account operational alerts. Keep all saved calendar IDs and credentials; do not drop the additive migration or reset delivery deduplication. A deployment rollback to pre-migration code must preserve new attribution data for a later redeploy.
