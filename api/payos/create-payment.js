import { getPayOSClient } from "../../server/payos/client.js";
import { getPaymentRedirectUrls } from "../../server/payos/config.js";
import {
  parseJsonBody,
  requireInternalAccess,
  requireMethod,
  sendError,
  sendJson,
} from "../../server/payos/http.js";
import { parseCreatePaymentRequest } from "../../server/payos/validation.js";

export default async function handler(req, res) {
  try {
    requireMethod(req, res, ["POST"]);
    requireInternalAccess(req);

    const payment = parseCreatePaymentRequest(parseJsonBody(req));
    const redirectUrls = getPaymentRedirectUrls();
    const result = await getPayOSClient().paymentRequests.create({
      ...payment,
      ...redirectUrls,
    });

    return sendJson(res, 201, { data: result });
  } catch (error) {
    return sendError(res, error);
  }
}

