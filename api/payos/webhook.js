import { getPayOSClient } from "../../server/payos/client.js";
import {
  parseJsonBody,
  requireMethod,
  sendError,
  sendJson,
} from "../../server/payos/http.js";
import { forwardVerifiedWebhook } from "../../server/payos/webhook-forwarder.js";
import { hasDatabase } from "../../server/db/pool.js";

const TEST_DESCRIPTIONS = new Set(["Ma giao dich thu nghiem", "VQRIO123"]);

function isPayOSTestWebhook(data) {
  return (
    TEST_DESCRIPTIONS.has(data.description) &&
    data.orderCode === 123 &&
    data.amount === 3000
  );
}

// The production webhook path stays byte-compatible: signature is verified here,
// the payOS confirmation sample still returns { test: true }. What changed for
// Functional 03 is that a real verified event now drives the F3 confirmation
// transaction (payment→succeeded + order→paid + inventory + outbox) when a
// privileged DB connection is configured. Without one, it preserves the original
// forward-to-order-service behaviour (and its 503-until-configured contract).
export default async function handler(req, res) {
  try {
    requireMethod(req, res, ["POST"]);

    const webhook = parseJsonBody(req);
    const verifiedData = await getPayOSClient().webhooks.verify(webhook);

    // payOS sends a signed sample event while confirming a webhook URL.
    if (isPayOSTestWebhook(verifiedData)) {
      return sendJson(res, 200, { success: true, test: true });
    }

    if (hasDatabase()) {
      const { confirmQrPayment } = await import("../../server/f3/payments.js");
      const result = await confirmQrPayment({
        provider: "payos",
        paymentLinkId: String(verifiedData.paymentLinkId),
        amount: Number(verifiedData.amount),
        reference: verifiedData.reference || String(verifiedData.paymentLinkId),
        eventType: "payment.paid",
        // Signature already verified by webhooks.verify() above.
        signatureValid: true,
      });
      // Always 2xx a verified event so payOS stops retrying (spec 5.4 / QR-03).
      return sendJson(res, 200, { success: true, handled: result.handled, status: result.status });
    }

    await forwardVerifiedWebhook(verifiedData);
    return sendJson(res, 200, { success: true });
  } catch (error) {
    return sendError(res, error);
  }
}
