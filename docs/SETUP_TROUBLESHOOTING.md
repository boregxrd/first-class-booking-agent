# Setup and troubleshooting handoff

Last updated: 2026-10-04. This document records the setup session, observed failures, actions taken, and unresolved checks. It contains no credential values.

## Current situation — start here

- The Worker is deployed; its root health endpoint works.
- D1, the message queue, dead-letter queue, and every-minute cron are configured. All four database migrations were applied remotely.
- Google service-account authentication and real Calendar roster creation/update/read-back passed a live test.
- OpenAI credentials are installed, but the last real model test failed with an exhausted API credit balance. Successful model generation is not yet verified.
- The Instagram account is professional, the Meta app is in **Development** mode, and the account-level `messages` subscription was confirmed through the API.
- Meta dashboard Test requests reach the callback. User-supplied structured logs also show Meta POST requests reaching it and receiving **HTTP 401**.
- In the current handler, HTTP 401 means signature verification failed. Determining the correct signing secret remains unresolved.
- The latest user report is that the account still did not answer. No new structured log was provided after the advice to check the separate Instagram App Secret, so the response status after that step is unknown.
- **The deployed configuration is still `META_MESSAGING_MODE=observe`. No AI processing or automatic replies are expected in this mode, even after incoming webhooks work.** WhatsApp notifications are disabled.

Do not equate a working health check, a dashboard Test, an account subscription, or a successful Calendar test with a verified end-to-end conversation.

## Resources and identifiers

These are configuration identifiers, not secrets.

| Resource | Value |
| --- | --- |
| Worker | `first-class-booking-agent` |
| Worker URL | `https://first-class-booking-agent.dallaswellnessclubweb.workers.dev` |
| Meta callback URL | `https://first-class-booking-agent.dallaswellnessclubweb.workers.dev/webhook` |
| D1 database | `dwc-booking-db` |
| D1 binding | `DB` |
| D1 database ID | `a99df476-5b40-4efc-8b9e-f638661246e2` |
| Queue / producer binding | `dwc-messages` / `MESSAGE_QUEUE` |
| Dead-letter queue | `dwc-messages-dlq` |
| Cron | `* * * * *` |
| Google calendar ID | `936849a7ca8a9073016a19b8d6ada7b967a43d66bbc9d9a532fbcfa7da21591f@group.calendar.google.com` |
| Google service account | `dwc-booking-agent@dwc-booking-test.iam.gserviceaccount.com` |
| Test Instagram username | `@dwctesthello` |
| Instagram account ID (`user_id`) | `17841450775304205` |
| Additional `id` returned by Instagram `/me` | `29170165772590226` |
| Parent Meta developer App ID, user-confirmed | `981085778361358` |
| Instagram App ID, user-confirmed | `2103576593579093` |
| App ID returned by `/subscribed_apps` | `18028841780692511` |
| Graph API version | `v26.0` |

**Do not interchange account IDs and app IDs.** The relationship between the subscribed-app ID and the two dashboard app IDs has not been independently established.

## Configuration and secrets

Current non-secret settings are in `wrangler.jsonc`:

```text
META_INSTAGRAM_ACCOUNT_ID=17841450775304205
META_GRAPH_API_VERSION=v26.0
META_MESSAGING_MODE=observe
WHATSAPP_NOTIFICATIONS_ENABLED=false
```

The following secret names were confirmed present in Cloudflare during this session:

```text
GOOGLE_CALENDAR_ID
GOOGLE_CLIENT_EMAIL
GOOGLE_PRIVATE_KEY
OPENAI_API_KEY
META_VERIFY_TOKEN
META_APP_SECRET
META_INSTAGRAM_ACCESS_TOKEN
```

Presence in `wrangler secret list` does not prove the value is correct, nonempty, unexpired, or belongs to the intended app. The user reported refreshing both Meta credentials more than once; the API continued to authenticate the expected Instagram account.

No actual Instagram token expiration has been recorded. No WhatsApp token, phone-number ID, or approved templates have been verified.

Commands are run in the Mac terminal from this repository. Secret updates use interactive prompts:

```sh
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_INSTAGRAM_ACCESS_TOKEN
npx wrangler secret list
```

Do not include secret values in this document, screenshots, commits, or issue/PR comments. The local Google JSON key is ignored by `/dwc-booking-test-*.json`; `.dev.vars` is also ignored.

## Setup history and problems encountered

### 1. Cloudflare dashboard and CLI login

- The Create Application screen offered GitHub, templates, and Hello World. None was needed: the existing repo was deployed through Wrangler.
- The default browser was inconvenient. `npx wrangler login --browser=false` printed a URL that was opened manually in the preferred browser.
- Login succeeded and `npx wrangler whoami` confirmed the intended Cloudflare account.

### 2. Wrangler upgrade failed with `ERESOLVE`

- Installing Wrangler 4 alone conflicted with the repo's v4 Cloudflare Worker types.
- Upgraded both dependencies together: Wrangler `4.147.0`, Worker types `5.20261004.1`.
- Updated `package.json` and `package-lock.json`.
- TypeScript, all 43 local tests, and a deployment dry run passed afterward.
- Wrangler `4.147.0` requires Node.js 22 or newer.

### 3. D1 binding generated with the wrong name

- The user created D1 and both queues successfully.
- Wrangler added a second D1 entry named `dwc_booking_db`, while the application expects `DB`; the original entry still had a placeholder UUID.
- Replaced the placeholder with the real database ID and removed the duplicate binding. The retained binding is `DB`.
- Applied migrations `0001` through `0004` remotely and verified there were no outstanding migrations.

### 4. Google credentials and Worker creation

- The user created a dedicated test calendar, enabled the Calendar API, and created a service account/key.
- The downloaded JSON key was placed in the repo directory. Added an ignore rule and verified the key file was untracked and ignored.
- The first secret-upload command was aborted because the user answered **no** to creating the Worker. No secret was added by that attempt.
- Retrying with **yes** created the Worker and uploaded the Google secrets. The private key was extracted from the JSON into Wrangler's stdin, rather than committed.
- `npm run deploy` subsequently published the actual application, queue consumer, and cron. The root health response worked.

### 5. Real Calendar integration test

- Pulled merged [PR #1](https://github.com/boregxrd/first-class-booking-agent/pull/1), which added `integration-tests/google-calendar.test.ts`.
- The pull initially failed because local `package.json` changes would be overwritten. Local setup changes were stashed, the pull fast-forwarded, and the changes were restored without conflicts. A backup stash was retained at that point.
- The live test authenticated, created a one-person roster, updated it to two people, and read it back.
- Its original assertion failed because Google returned Dallas-offset time while the test expected a UTC string. Those strings represented the same instant.
- Fixed the assertion to compare `Date.parse(persisted.start.dateTime)` with the requested timestamp.
- Reran at another unused slot: **passed**.
- Two synthetic events were left in the test calendar on October 6, 2026, at **3 PM and 4 PM Dallas time**, titled `DWC Free Trials — 2 prospects`.
- This test calls the Calendar adapter from the local machine. It does **not** exercise the deployed Worker or `D1BookingService` against remote D1 and real Google together.

### 6. OpenAI setup and billing failure

- Installed `OPENAI_API_KEY` as a Cloudflare secret. The user subsequently reported replacing the original key.
- The application uses `gpt-4.1-mini` by default and sends `store: false`.
- A real request through the deployed Worker reached OpenAI, which returned:

  ```text
  HTTP 429
  type: insufficient_quota
  code: credit_balance_exhausted
  ```

- This was a billing/credit issue, not confirmed temporary request throttling. Successful generation has not been retested or established.

### 7. Meta onboarding and account creation

- Initially blocked by Meta restrictions on very recently created accounts.
- Linking Instagram to Facebook failed in the dashboard. The chosen integration is **Instagram API with Instagram Login**, which does not require a Facebook Page link.
- The user created a new Instagram account and switched it to professional Business mode.
- The personal Instagram account is intended as the test sender; `@dwctesthello` is the receiving Business account.
- The developer app is confirmed to be in **Development** mode. Test-sender role/invitation requirements and acceptance have not been fully verified.

### 8. Callback verification initially failed

- Meta reported that the callback URL or verify token could not be validated.
- The public callback returned **HTTP 500 `Server Misconfigured`**, despite `META_VERIFY_TOKEN` appearing in the secret list. The handler saw a missing/empty value; the precise underlying cause was not established.
- Replaced the verify token and tested the GET subscription challenge directly.
- The callback returned **HTTP 200 with the exact challenge**. The replacement token was provided to the user for Meta's form; its value is intentionally omitted here.
- Use the exact `/webhook` URL without a trailing slash. `/webhook/` returned 404 during a diagnostic check.
- Later dashboard Test POST requests reached the Worker. That is separate from GET callback verification and from signature acceptance.

### 9. Dashboard Test worked, but real DMs appeared absent

- Initial logs showed only cron executions. Cron does not poll Instagram messages.
- Meta's Test (`messages`) produced POST events, while personal-account DMs appeared not to.
- The Business account's messages were found in **Hidden Requests**. Accepting the conversation, replying manually once, and sending a fresh message were recommended. Completion of those steps was not independently confirmed.
- Account API checks authenticated `@dwctesthello` and confirmed its `user_id` matches the configured account ID.
- Initially, `GET /{account_id}/subscribed_apps` returned an empty list.
- Direct `POST /{account_id}/subscribed_apps` with `subscribed_fields=messages` returned `success: true`. Follow-up GET confirmed the subscription.
- Repeated checks after credential refreshes continued to report subscribed app ID `18028841780692511`.

### 10. App-ID mismatch investigation remained inconclusive

- The user confirmed parent App ID `981085778361358` and Instagram App ID `2103576593579093` in the intended dashboard.
- Neither equals the subscribed-app ID returned by the API.
- Early advice treated this as evidence of the wrong app/token. **That conclusion was not proven**: Meta has multiple app/account ID namespaces, and token-ownership inspection did not succeed.
- Facebook token-debug attempts returned a transient service error and an application-validation error. An Instagram token-metadata attempt was denied.
- A permissions query returned `nonexisting field (permissions)`; this is an unsupported query, **not proof that messaging permissions are absent**.
- The user regenerated/reuploaded the access token and refreshed the parent Meta App Secret. Identity and subscription checks succeeded again, but the third app ID remained.
- Do not keep rotating credentials solely because these IDs differ. Establish the signing app/secret and token ownership through the correct provider tooling.

### 11. Structured logs revealed signature rejection

- A plain `POST /webhook - Ok` log was misleading: `outcome: ok` means execution completed, not that the HTTP response was successful.
- Running `npx wrangler tail --format=json` exposed **two POST responses with `status: 401`**, `logs: []`, and no exceptions.
- Requests included `x-hub-signature-256` and Instagram API version `v26.0`.
- `src/channels/meta.ts` returns 401 when `verifyMetaSignature` fails against `META_APP_SECRET`. Processing stops before observing/ingesting the message, explaining the empty application logs.
- Advice was then updated to inspect the **separate Instagram App Secret**, if shown in the Instagram Login setup, rather than assume the parent app's Basic-settings secret signs these callbacks.
- The earlier recommendation to use the Basic-settings secret may have been wrong for this setup. **The actual secret matching the delivered signatures is not yet verified.**
- The supplied 401 events were from Worker version `97c7c462-bf0b-4af4-a522-4cfdd0341077`. Subsequent diagnostic deployments/restorations occurred. Obtain a fresh event before assuming the old result describes the latest secret/configuration.

## Diagnostics performed and their limits

Temporary protected diagnostic handlers were used to call OpenAI and Meta using the Worker secrets. The normal application handlers were preserved and the standard entrypoint was redeployed afterward. Those diagnostic sources were outside the repo and are not included in the PR.

- Cloudflare remote preview returned 403 during the initial OpenAI attempt.
- Python HTTP requests to the public Worker hit Cloudflare error 1010; `curl` reached it successfully.
- A temporary diagnostic route initially returned 404 until deployment propagation completed; later checks waited for the new route.
- These tooling issues do not establish a failure in Meta or OpenAI credentials.

## How to resume troubleshooting

1. **Verify incoming signature acceptance first.** Start the live tail below, then send a fresh personal-account DM into the accepted Business inbox. Record whether it is a real DM, dashboard Test, or outgoing Business-account message.
2. Check `event.response.status`, `logs`, and `exceptions`. Do not rely on `outcome: ok`.
3. If it is still 401, confirm the exact app signing the callbacks and its corresponding secret. Check whether Instagram Login exposes a separate Instagram App Secret. Upload the matching value privately; do not bypass signature verification.
4. After signature acceptance, check for HTTP 200 and `[Webhook observed]`, capturing the sender and recipient/account IDs. Confirm whether the delivered account ID matches the configured one; do not change it based solely on app IDs.
5. If POST delivery is absent, inspect Development-mode roles/tester invitations, account message-access settings, subscriptions, and Hidden Requests. The role/invitation state is still undocumented.
6. Resolve OpenAI API billing and obtain a successful real model response.
7. Record the actual Instagram token expiry. Enable `META_MESSAGING_MODE=test` with the exact observed `META_TEST_INSTAGRAM_SENDER_IDS`. Keep WhatsApp notifications disabled.
8. Verify DM → model → Instagram reply, then deployed D1 booking → real Calendar, including reschedule/cancel and two prospects in one slot.
9. Configure WhatsApp separately: number, credentials, approved templates, consent, and delivery/reminder tests. None of those live checks is complete.

```sh
npx wrangler tail --format=json
npx wrangler secret list
npx wrangler deployments list
```

Inspect new POST events, not only every-minute cron events. Tail is live and does not replay older events. A Business-account outgoing message may be an echo, which the handler intentionally ignores.

## Git and verification status

- [PR #2](https://github.com/boregxrd/first-class-booking-agent/pull/2) was created from `chore/cloudflare-setup-calendar-test`.
- PR #2 was subsequently confirmed merged into `main`. There is no `prod` branch; the handoff and later Instagram settings are being committed on `main` at the user's request.
- Commit `4c3fefc` includes the Cloudflare database configuration, dependency upgrades, credentials ignore rule, and Calendar timestamp assertion fix.
- `@bangleaf` was tagged in a review-request comment. Formal reviewer assignment failed because GitHub reported they were not a repository collaborator.
- Instagram account/version/observe-mode variables were added to `wrangler.jsonc` and deployed **after** that commit. At the start of this handoff task, that file was locally modified and not committed.
- Last completed checks: TypeScript passed, all 43 local tests passed, live Calendar integration test passed. External model generation, real inbound signature acceptance, automatic replies, and full deployed booking/messaging flow remain unverified.

Related documents: [operations](OPERATIONS.md), [Meta setup](meta/README.md), [roadmap](../ROADMAP.md), and [implementation review](REVIEW.md). This handoff records the actual setup session; older setup instructions may still use future-tense wording.
