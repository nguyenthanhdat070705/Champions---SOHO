import { getPayOSClient } from "../../server/payos/client.js";
import {
  parseJsonBody,
  requireInternalAccess,
  requireMethod,
  sendError,
  sendJson,
} from "../../server/payos/http.js";
import {
  parseCancellationReason,
  parsePaymentIdentifier,
} from "../../server/payos/validation.js";

export default async function handler(req, res) {
  try {
    requireMethod(req, res, ["GET", "DELETE"]);
    requireInternalAccess(req);

    const id = parsePaymentIdentifier(req.query?.id);
    const payOS = getPayOSClient();

    if (req.method === "GET") {
      const payment = await payOS.paymentRequests.get(id);
      return sendJson(res, 200, { data: payment });
    }

    const reason = req.body
      ? parseCancellationReason(parseJsonBody(req))
      : undefined;
    const payment = await payOS.paymentRequests.cancel(id, reason);
    return sendJson(res, 200, { data: payment });
  } catch (error) {
    return sendError(res, error);
  }
}
