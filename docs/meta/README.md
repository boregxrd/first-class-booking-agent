# Instagram and Cloudflare setup — starting from zero

## First milestone

Receive a test Instagram DM in the deployed Worker's logs. This proves account authorization and webhook delivery, not a complete AI conversation. Default observe mode logs metadata without invoking the model or sending a reply. The durable runtime is implemented; follow `docs/OPERATIONS.md` for migrations, queue resources and enabling test traffic.

Cloudflare Workers runs our HTTPS API and processing code. D1 stores state. Queues runs durable background processing. OpenAI generates responses. Meta delivers incoming events and accepts outgoing replies. No custom domain is needed for the first milestone: a `workers.dev` HTTPS URL works.

## What to ask the gym owner

1. Confirm the Instagram handle (expected: `@dallaswellnessclubb`).
2. Is it a professional Business/Creator account or a personal account? Use a professional account; Business is appropriate for the gym.
3. Can the owner sign in and approve connecting a new application, including any two-factor prompt? Arrange a short setup session rather than exchanging passwords.
4. Is there an existing Meta Business Portfolio? If yes, ask for its name/ID and have the owner invite the developer with access needed to administer the app and Instagram asset. The exact permission options depend on how the asset is managed.
5. Is the Instagram account linked to a Facebook Page? Record the answer, but the preferred Instagram Login route does not require creating/linking a Page just for this integration.
6. Are automated DMs currently active from another app? Coordinate testing to avoid two bots responding to the same test conversation.
7. Choose a separate Instagram account for sending test DMs and arrange any required tester-role invitations/acceptance in the app dashboard.

The owner approves authorization in Meta/Instagram. An Instagram username/password is not the API credential. App secrets, access tokens and two-factor codes should not be pasted into chat or committed to git.

## 1. Create the Cloudflare account

- Sign up at https://dash.cloudflare.com/sign-up/workers-and-pages and verify the email.
- Prefer an owner-controlled account and invite collaborators. A developer-owned test account is also usable for initial tests if that is the agreed arrangement.
- Start with the available free Workers offering for the webhook smoke test; review limits/plan requirements when adding D1 and Queues. No domain registration or DNS migration is required.
- In this existing repository, run `npx wrangler login` and approve the browser authorization, then `npx wrangler whoami` to confirm the selected account. Do not scaffold another Worker project.
- Before the first deployment, check that the installed Wrangler supports the project's compatibility date; update Wrangler if required and rerun checks.

The assistant can run CLI commands after browser login. Account creation, email verification, billing choices and authorization approval require the account holder.

## 2. Create the Meta app and connect Instagram

- Register/sign in at https://developers.facebook.com/ and open **My Apps**.
- Create an app for Instagram professional-account messaging. Prefer **Instagram API with Instagram Login** for this project. App-creation use-case labels and setup screens vary; inspect the actual available choices rather than selecting an unrelated Facebook Login flow.
- Associate the appropriate Business Portfolio if the dashboard requires it.
- Open the Instagram product/use-case setup. Request the basic-account and messaging capabilities for this route. Expected permission names are `instagram_business_basic` and `instagram_business_manage_messages`; confirm the names and access requirements in the current dashboard.
- Add/authorize the gym's professional Instagram account. The owner must complete the Instagram consent flow. If a tester invitation is required, accept it using the invited account.
- Enable access to messages for connected tools if prompted by Instagram's settings/setup.
- Record the authorized Instagram account ID and the relevant app ID. Securely store the corresponding app/webhook secret and Instagram user access token. Do not substitute a Facebook Page token for the Instagram Login route.
- Record token expiration and the route's supported refresh/exchange procedure. A generated development token is not an indefinite production credential.

Do not mix the Instagram Login and Facebook Login permission/token/endpoint families. The outgoing API adapter will be implemented against the route selected here.

### Development versus public access

First test with the accounts/assets and app roles allowed in development mode. Authorization, asset subscription and tester setup may all be necessary; a dashboard test payload alone does not demonstrate real DM delivery.

Before allowing arbitrary prospects, check the app dashboard's Standard/Advanced Access and App Review requirements for messaging and your own-business use case. Business verification and privacy-policy/data-deletion URLs may be required. Do not assume switching an app to Live grants missing permissions. Resolve the specific dashboard requirements before promising a public launch.

## 3. Deploy the webhook receiver

From the existing repository, after Cloudflare login:

```sh
npm run typecheck
npm test
npm run deploy
```

The first deployment establishes the Worker URL; protected webhook requests will not work until secrets are installed. Use the actual URL printed by Wrangler, for example:

```text
https://first-class-booking-agent.<your-subdomain>.workers.dev
```

Set the following via the Worker's **Settings → Variables and Secrets**, selecting type **Secret**, or via interactive CLI prompts:

```sh
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put META_APP_SECRET
```

- `META_VERIFY_TOKEN`: a random string we choose and also enter into Meta's webhook verification form. It is not a Meta access token.
- `META_APP_SECRET`: the secret corresponding to the configured Meta/Instagram webhook product; used to verify incoming signatures.

For later model/outbound testing:

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put META_INSTAGRAM_ACCESS_TOKEN
```

Use the Instagram Login token for `META_INSTAGRAM_ACCESS_TOKEN`. Set `META_INSTAGRAM_ACCOUNT_ID`, `META_GRAPH_API_VERSION` and the token's expiry. WhatsApp uses its own `META_WHATSAPP_ACCESS_TOKEN` and `META_WHATSAPP_PHONE_NUMBER_ID`. OpenAI and outbound Meta secrets are not required just to verify receipt of a webhook.

For local development, use the ignored `.dev.vars` file based on `.dev.vars.example`. Local values do not automatically become deployed Worker secrets. Secret updates can deploy a new Worker version.

## 4. Subscribe the webhook

In the Instagram product's webhook configuration:

- **Callback URL:** `https://<actual-worker-host>/webhook`
- **Verify token:** the exact deployed `META_VERIFY_TOKEN` value
- Complete the verification challenge.
- Subscribe to the Instagram messaging field(s) required for direct text messages; start with `messages` where offered. Add other events only as their handlers are implemented.
- Complete the professional account's app/webhook subscription step too. App-level callback verification alone may not subscribe the gym account. Use the selected product's dashboard/API instructions for that account subscription.

Instagram webhook callbacks, OAuth redirect URLs and WhatsApp webhook subscriptions are different configuration items. `/webhook` is not an OAuth callback. If the dashboard flow requires a custom OAuth redirect instead of its provided account/token setup, implement that endpoint with state validation and token exchange before configuring it.

## 5. Verify real delivery

```sh
npx wrangler tail
```

1. Open the Worker root URL and check the health response.
2. Verify the Meta callback and, if available, send a dashboard test event.
3. Send a new DM to the gym from the permitted test Instagram account.
4. Confirm an Instagram inbound event appears in logs.
5. Do not expect an AI reply yet: the current handler only logs it.

### Testing alongside the existing bot

Keep `META_MESSAGING_MODE=observe` (also the default when unset). A verified incoming event reveals your scoped `senderId` in metadata logs. Once the integration fixes are complete, set `META_MESSAGING_MODE=test` and `META_TEST_INSTAGRAM_SENDER_IDS=<that exact ID>` to restrict our processing to your account. Do not put `@username` in the ID list. `live` mode removes the allowlist and is only for the eventual public rollout. These modes gate conversations, not scheduled notifications; keep template sending unconfigured during webhook observation tests.

Our allowlist doesn't disable the existing vendor bot. Arrange a test-user exclusion/pause with that system or use a separate test professional account. Do not disconnect the existing production integration merely to create our app.

Use synthetic test messages/contact details for this milestone. The adapter logs metadata, not message text.

Next: configure D1/Queues and secrets, enable the test allowlist, then prove DM → model → Instagram reply. The local tests already cover the full two-prospect booking flow with mocked providers.

## Information to share with the developer

Safe setup status to share: professional-account type, handle, whether owner authorization is available, existing Portfolio/Page details if applicable, Cloudflare login completion, Worker URL, Meta app ID, authorized Instagram account ID, granted permission names and redacted screenshots of setup errors/use-case choices.

Enter secrets directly into `.dev.vars` or Cloudflare's secret settings. Do not include them in screenshots.

## References and verification limits

- Cloudflare first deployment: https://developers.cloudflare.com/workers/get-started/guide/
- Cloudflare secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Meta Instagram Login: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
- Meta messaging: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/

Cloudflare documentation was retrieved during setup planning. Meta's documentation returned HTTP 400 to the automated fetcher; the exact dashboard labels, permission/access requirements and account subscription procedure must be checked in the owner's signed-in dashboard/current documentation during onboarding.
