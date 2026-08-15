import { getWebhookForwardConfig } from "./config.js";
import { RequestError } from "./errors.js";

export async function forwardVerifiedWebhook(webhookData) {
  const config = getWebhookForwardConfig();

  if (!config) {
    throw new RequestError(
      503,
      "Webhook signature is valid, but PAYOS_WEBHOOK_FORWARD_URL is not configured",
    );
  }

  const idempotencySource = String(
    webhookData.reference || webhookData.paymentLinkId,
  )
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 120);

  const headers = {
    "Content-Type": "application/json",
    "Idempotency-Key": `payos-${idempotencySource}`,
    "X-PayOS-Verified": "true",
  };

  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  const response = await fetch(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "payos",
      type: "payment.paid",
      data: webhookData,
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new RequestError(
      503,
      `Order service rejected the webhook with HTTP ${response.status}`,
    );
  }
}
