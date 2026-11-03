# Lightning subscription backend

Node.js API for Dodo Payments checkout and subscription entitlements. Subscription
state is stored in Turso (libSQL). Access is granted only after a signed Dodo
webhook, never from a browser redirect.

## Render deployment

The repository includes a Render Blueprint in `render.yaml`. Review it and
create the service from the Blueprint. If creating a service manually, use this
folder as its root directory (`stealth-backend/stealth-backend` from the
workspace root).

- Runtime: Node
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/health`
- Node version: 20 or newer

Set all prompted environment variables, including Turso and Dodo **test-mode**
credentials, before the service passes its health check. The service listens on
Render's `PORT` and binds to `0.0.0.0`.

## Configure Turso

Create a Turso database and an auth token using the Turso CLI or dashboard. Add
these values as Render environment variables; never commit them or paste them in
chat:

- `TURSO_DATABASE_URL`: database URL beginning with `libsql://`
- `TURSO_AUTH_TOKEN`: database auth token

The service creates its tables and index on startup. Use a persistent Turso
database for deployed environments; the embedded `file::memory:` database is
for tests only.

## Configure Dodo Payments

In Dodo **Test Mode**, configure a recurring product for **INR 999 per month**.
Verify its price, currency, and billing interval in the Dodo dashboard. Configure
a webhook to:

`https://<your-render-address>/webhooks/dodo`

Subscribe the webhook to `subscription.active`, `subscription.updated`,
`subscription.past_due`, `subscription.on_hold`, `subscription.paused`,
`subscription.unpaused`, `subscription.renewed`, `subscription.plan_changed`,
`subscription.cancelled`, `subscription.failed`, and `subscription.expired`.

Set these Render environment variables:

- `DODO_PAYMENTS_API_KEY`: server-side API key for the same Dodo environment
- `DODO_PAYMENTS_WEBHOOK_KEY`: signing secret for the Dodo webhook above
- `DODO_PAYMENTS_ENVIRONMENT`: `test_mode` first; use `live_mode` only after
  testing and separately configuring live credentials/webhooks
- `DODO_PRODUCT_ID`: ID of the recurring INR 999/month product
- `DODO_RETURN_URL`: trusted HTTPS URL to return to after checkout
- `APP_ALLOWED_ORIGINS`: comma-separated, exact website origins, e.g.
  `https://liteing.netlify.app`

Checkout requests set `trial_period_days` to **7**. The Dodo product must be a
subscription product; verify the final billing terms in Dodo before going live.
No API or webhook secrets belong in website or desktop-app code.

Set the required environment variables before deployment so `/health` can pass.
After updating them, redeploy and check `/health`. It should return HTTP 200
with `billing_configured: true`; missing configuration returns HTTP 503.
Configure the Dodo test webhook and send a test event; the endpoint should
return HTTP 200 for a valid signed event.

For local development, copy `.env.example` to `.env`, fill in test-mode values,
and load them in your shell or local environment manager. The server does not
load `.env` files itself.

## API

### `POST /api/billing/checkout`

Request JSON:

```json
{"email":"customer@example.com"}
```

Returns an HTTPS `checkout_url`, provider `session_id`, and a randomly generated
`access_token`. The token is returned once and stored server-side only as a
SHA-256 hash. The app must store the token securely and send it as a bearer
token to the entitlement route. This starter flow does not verify ownership of
the submitted email; connect it to the app's verified sign-in before a public
launch. Checkout is rate-limited to 10 attempts per IP per 15 minutes.

### `GET /api/entitlements`

Requires `Authorization: Bearer <access_token>`. Returns `entitled`, plan phase,
subscription status, and access end time. Access is false until a verified
subscription webhook arrives. Trial access expires after seven days unless a
successful renewal extends access. Pauses, failures, expiry, cancellation, and
changes away from the configured product are enforced from Dodo events.

### `POST /webhooks/dodo`

Configure this exact webhook path in Dodo. The Dodo SDK verifies the untouched
request body and Standard Webhooks headers. Webhook IDs are processed
transactionally for idempotency; older events cannot overwrite newer state.

## Tests

```powershell
npm ci
npm test
```

Tests use a local in-memory libSQL database, mock checkout creation, and the
Dodo SDK's real webhook signature verifier. They do not contact Dodo or charge
a payment method.

## Remaining app integration

The website's download buttons and desktop app are not connected to this API.
The desktop app must securely save the returned token and check
`GET /api/entitlements` before granting model access. The actual Windows and
macOS installers must also be supplied and published separately.
