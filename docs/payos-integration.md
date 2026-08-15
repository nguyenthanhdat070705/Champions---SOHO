# payOS integration

This repository uses the current official `@payos/node` SDK and exposes these
Vercel Functions:

- `POST /api/payos/create-payment`: create a payment link.
- `GET /api/payos/payment?id=...`: read payment status by order code or link ID.
- `DELETE /api/payos/payment?id=...`: cancel a payment link.
- `POST /api/payos/webhook`: verify signed payOS webhooks and forward verified
  events to the order service.

The public payOS demo repository was not copied into this project because it is
based on SDK v1 and its last commit predates the v2 SDK used here.

## 1. Create a payOS payment channel

Create or sign in to an account at <https://my.payos.vn>, finish identity or
business verification, link the receiving bank account, and create a payment
channel. Copy its Client ID, API Key, and Checksum Key.

Do not paste these values into source code or commit them to Git.

## 2. Configure environment variables

Copy `.env.example` to `.env.local` for local development. In production, add
the same values under Vercel Project Settings > Environment Variables.

Generate `PAYOS_INTERNAL_API_TOKEN` with a password manager or a cryptographic
random generator. This token protects create, lookup, and cancel endpoints until
the app's own authentication is connected.

`PAYOS_WEBHOOK_FORWARD_URL` must point to an order-service endpoint that:

1. Authenticates `PAYOS_WEBHOOK_FORWARD_TOKEN` when configured.
2. Uses `data.orderCode` to load the expected order.
3. Checks the expected amount and current order state.
4. Updates the order atomically and idempotently.
5. Returns a 2xx response only after the update is durable.

Until this URL is configured, real webhooks intentionally return HTTP 503 so
payOS retries instead of silently losing a payment notification. Signed sample
events used by payOS to confirm the webhook URL still return HTTP 200.

## 3. Deploy and confirm the webhook

After the production endpoint is deployed, set `PAYOS_WEBHOOK_URL` to:

```text
https://your-domain.example/api/payos/webhook
```

Load your environment variables in the terminal and run:

```bash
npm run payos:confirm-webhook
```

This asks payOS to send its signed test event to the deployed endpoint and then
registers the URL for the payment channel.

## 4. Create a payment link

Only a trusted backend should call this endpoint. `orderCode` must be the unique
positive integer stored in your order database. The default description is
ASCII and at most nine characters for compatibility with bank accounts that
have the stricter payOS description limit.

```bash
curl -X POST https://your-domain.example/api/payos/create-payment \
  -H "Authorization: Bearer $PAYOS_INTERNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orderCode":12345678,"amount":50000,"items":[{"name":"Goi SOHO","quantity":1,"price":50000}]}'
```

Use `data.checkoutUrl` from the response to redirect the customer to payOS.
Never mark an order paid from the browser return URL; only the verified webhook
or a server-side payment status check is authoritative.

## 5. Test carefully

payOS does not provide a separate sandbox. Test with a small real transfer,
verify the redirect and webhook paths, and confirm duplicate delivery does not
double-credit the order.

