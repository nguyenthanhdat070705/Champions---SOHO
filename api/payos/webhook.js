import { getPayOSClient } from "../../server/payos/client.js";
import {
  parseJsonBody,
  requireMethod,
  sendError,
  sendJson,
} from "../../server/payos/http.js";
import { forwardVerifiedWebhook } from "../../server/payos/webhook-forwarder.js";

const TEST_DESCRIPTIONS = new Set(["Ma giao dich thu nghiem", "VQRIO123"]);

function isPayOSTestWebhook(data) {
  return (
    TEST_DESCRIPTIONS.has(data.description) &&
    data.orderCode === 123 &&
    data.amount === 3000
  );
}

export default async function handler(req, res) {
  try {
    requireMethod(req, res, ["POST"]);

    const webhook = parseJsonBody(req);
    const verifiedData = await getPayOSClient().webhooks.verify(webhook);

    // payOS sends a signed sample event while confirming a webhook URL.
    if (isPayOSTestWebhook(verifiedData)) {
      return sendJson(res, 200, { success: true, test: true });
    }

    await forwardVerifiedWebhook(verifiedData);
    return sendJson(res, 200, { success: true });
  } catch (error) {
    return sendError(res, error);
  }
}
